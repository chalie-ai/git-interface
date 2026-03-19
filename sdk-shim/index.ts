/**
 * @module sdk-shim/index
 *
 * Higher-level API façade for the Chalie Interface SDK shim.
 *
 * This module provides the simplified public surface that the rest of the
 * tool imports via `@chalie/interface-sdk`. It re-exports the core IPC
 * helpers (`sendMessage`, `sendSignal`, `dataDir`) from `./ipc.ts` and
 * wraps the lower-level registry and secrets backends behind ergonomic
 * three-argument and object-property APIs.
 *
 * ## Capability registration
 *
 * ```ts
 * import { registerCapability, dispatch } from "@chalie/interface-sdk";
 *
 * registerCapability("pr_list", { description: "List PRs", parameters: { type: "object", properties: {} } }, async (ctx) => {
 *   return { text: "No PRs yet." };
 * });
 *
 * const result = await dispatch("pr_list", { repo: "owner/repo" });
 * ```
 *
 * ## Secrets
 *
 * ```ts
 * import { secrets } from "@chalie/interface-sdk";
 *
 * await secrets.set("github_token", "ghp_xxxxxxxxxxxx");
 * const token = await secrets.get("github_token"); // string | null
 * ```
 *
 * ## Secret storage backend resolution order
 *
 * 1. **Chalie secrets API** — used when `CHALIE_SECRETS_SOCKET` env var is
 *    set (preferred; tokens are managed by the Chalie runtime).
 * 2. **Encrypted file fallback** — used when
 *    `CHALIE_ALLOW_PLAINTEXT_SECRETS=1` is set. Writes to
 *    `{dataDir}/secrets.enc.json` with mode `600`. Requires explicit
 *    opt-in; never enabled silently.
 *
 * Raw token values are **never** written to `monitor.json` or any
 * source-controlled file.
 */

// ---------------------------------------------------------------------------
// Re-exports from lower-level modules
// ---------------------------------------------------------------------------

export { dataDir, sendMessage, sendSignal } from "./ipc.ts";

// ---------------------------------------------------------------------------
// Internal imports for wrapping
// ---------------------------------------------------------------------------

import { dispatch as _dispatch, registerCapability as _registerCapability } from "./registry.ts";
import { retrieveSecret, storeSecret } from "./secrets.ts";
import type { CapabilityHandler, CapabilityResult, CapabilitySchema } from "./types.ts";

// ---------------------------------------------------------------------------
// Capability registry façade
// ---------------------------------------------------------------------------

/**
 * Registers a named capability with Chalie's dispatcher.
 *
 * This is a three-argument convenience wrapper around the lower-level
 * `registry.registerCapability(schema, handler)`. The `name` argument is
 * spliced into the schema, so callers do not need to repeat it inside the
 * schema object.
 *
 * Must be called before `runEventLoop`. Registering the same `name` twice
 * overwrites the previous entry.
 *
 * @param name - Unique snake_case identifier for the capability
 *   (e.g. `"pr_list"`).
 * @param schema - Capability metadata and JSON Schema for parameters.
 *   The `name` field must NOT be provided here; it is taken from the
 *   first argument.
 * @param handler - Async function invoked when the capability is called.
 *
 * @example
 * ```ts
 * registerCapability(
 *   "pr_list",
 *   {
 *     description: "List open pull requests for a repository.",
 *     parameters: {
 *       type: "object",
 *       properties: { repo: { type: "string" } },
 *       required: ["repo"],
 *     },
 *   },
 *   async (ctx) => ({ text: `Listing PRs for ${ctx.params["repo"]}` }),
 * );
 * ```
 */
export function registerCapability(
  name: string,
  schema: Omit<CapabilitySchema, "name">,
  handler: CapabilityHandler,
): void {
  _registerCapability({ ...schema, name }, handler);
}

/**
 * Dispatches a capability call by name and argument map.
 *
 * This is a simplified wrapper around the lower-level
 * `registry.dispatch(message)`. Callers pass the capability name and a
 * plain parameter record instead of constructing an `InboundMessage`.
 *
 * @param name - The snake_case name of the capability to invoke
 *   (e.g. `"pr_list"`).
 * @param args - Parameter map passed verbatim to the capability handler's
 *   `ctx.params`. Defaults to an empty object.
 * @returns A promise resolving to the {@link CapabilityResult} returned by
 *   the handler, or an error result if dispatch fails.
 *
 * @example
 * ```ts
 * const result = await dispatch("pr_list", { repo: "owner/repo", state: "open" });
 * console.log(result.text);
 * ```
 */
export function dispatch(
  name: string,
  args: Record<string, unknown> = {},
): Promise<CapabilityResult> {
  return _dispatch({ capability: name, params: args });
}

// ---------------------------------------------------------------------------
// Secrets façade
// ---------------------------------------------------------------------------

/**
 * High-level secrets object providing `get` and `set` operations.
 *
 * Tokens and other sensitive values should be stored exclusively through
 * this interface; they are never written to `monitor.json` or any other
 * plaintext file without explicit user consent.
 *
 * Storage backend is resolved in the following order:
 * 1. **Chalie secrets API** — when `CHALIE_SECRETS_SOCKET` is set.
 * 2. **Encrypted file fallback** — when `CHALIE_ALLOW_PLAINTEXT_SECRETS=1`
 *    is set; writes to `{dataDir}/secrets.enc.json`.
 *
 * @example
 * ```ts
 * await secrets.set("github_token", pat);
 * const token = await secrets.get("github_token");
 * if (token === null) { /* prompt user for token *\/ }
 * ```
 */
export const secrets: {
  /**
   * Retrieves a secret by its logical key.
   *
   * Tries the Chalie secrets socket first; falls back to the encrypted
   * file store if the socket is not configured. Returns `null` when the
   * key has not been stored or no backend is available.
   *
   * @param key - Logical key for the secret (e.g. `"github_token"`).
   * @returns The stored secret value, or `null` if not found or unavailable.
   */
  get(key: string): Promise<string | null>;

  /**
   * Stores a secret under a logical key using the best available backend.
   *
   * The raw value is never written to `monitor.json`. Only an opaque
   * `SecretRef` reference key is persisted in application state.
   *
   * @param key - Logical key for the secret.
   * @param val - Secret value to store (e.g. a personal access token).
   * @throws {Error} If no secure storage backend is configured and
   *   `CHALIE_ALLOW_PLAINTEXT_SECRETS=1` is not set.
   */
  set(key: string, val: string): Promise<void>;
} = {
  async get(key: string): Promise<string | null> {
    const chalieSocket = Deno.env.get("CHALIE_SECRETS_SOCKET");
    if (chalieSocket) {
      return (await retrieveSecret(`chalie:${key}`)) ?? null;
    }
    if (Deno.env.get("CHALIE_ALLOW_PLAINTEXT_SECRETS") === "1") {
      return (await retrieveSecret(`file:${key}`)) ?? null;
    }
    return null;
  },

  async set(key: string, val: string): Promise<void> {
    await storeSecret(key, val);
  },
};
