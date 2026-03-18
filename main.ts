/**
 * @module main
 *
 * Entry point for the Chalie Git Interface tool.
 *
 * ## Startup sequence
 *
 * 1. Register all capabilities with the SDK shim's dispatcher via
 *    {@link registerAllCapabilities}.
 * 2. Load persistent monitor state from disk via {@link loadState}.
 * 3. If at least one platform (GitHub or GitLab) is configured and not in an
 *    auth-failed state, start the background poller via {@link startPoller}.
 * 4. Install a `SIGINT` handler that flushes state to disk before the process
 *    exits (e.g. `Ctrl-C` during local development).
 * 5. Enter an indefinite IPC request-dispatch loop:
 *    - Read one base64-encoded JSON message from stdin via {@link readRequest}.
 *    - Extract the capability name and parameters from the decoded message.
 *    - Dispatch to the registered handler via {@link dispatch}.
 *    - Serialise the result — promoting plain text that looks like HTML markup
 *      to the `html` wire field; falling back to a JSON-stringified `text`
 *      field for structured data.
 *    - Write the serialised response to stdout via {@link writeResponse}.
 *    - On {@link ApiError}, return `{ error: err.message }`.
 *    - On any other thrown value, return a generic `{ error }` response
 *      without crashing the loop.
 *
 * ## Execution model
 *
 * The process runs indefinitely (interactive / daemon mode).  Chalie's
 * runtime is responsible for terminating the process when the user session
 * ends.  `SIGINT` (e.g. `Ctrl-C`) triggers a clean shutdown with state
 * persistence.
 *
 * ## Error contract
 *
 * | Condition | Response |
 * |-----------|----------|
 * | `ApiError` thrown by a handler | `{ error: err.message }` (platform-tagged) |
 * | Unknown `Error` thrown | `{ error: err.message }` |
 * | Non-Error thrown | `{ error: "An unexpected error occurred." }` |
 * | stdin closed (EOF) | Loop exits cleanly; state flushed to disk. |
 *
 * @example Start locally for development:
 * ```sh
 * deno task dev
 * ```
 */

import { dispatch, readRequest, writeResponse } from "@chalie/interface-sdk";
import type { CapabilityResult, OutboundResponse, Scopes } from "@chalie/interface-sdk";
import { registerAllCapabilities } from "~/capabilities/mod.ts";
import { getState, loadState, saveState, startPoller } from "~/monitor/mod.ts";
import type { MonitorState } from "~/monitor/mod.ts";
import { ApiError } from "~/shared/mod.ts";

// ---------------------------------------------------------------------------
// Scope declaration
// ---------------------------------------------------------------------------

/**
 * Declares the signal and message topics emitted by this tool.
 *
 * Used at startup to advertise the tool's intent to the Chalie runtime.
 * While `runEventLoop` from the registry accepts this as an argument, this
 * entry point implements its own loop; `SCOPES` is kept here for
 * documentation and future SDK compliance.
 */
const SCOPES: Scopes = {
  messages: [
    "review_request",
    "ci_failure",
    "security_alert",
    "mention",
    "pr_merged",
    "issue_assigned",
  ],
  signals: [
    "review_request",
    "ci_failure",
    "ci_recovery",
    "security_alert",
    "mention",
    "pr_merged",
    "pr_closed",
    "issue_assigned",
    "pipeline_trigger",
  ],
};

// Silence "unused variable" linter warning: SCOPES is kept for documentation
// and future SDK compliance but is not consumed by the custom event loop.
void SCOPES;

// ---------------------------------------------------------------------------
// Response serialisation
// ---------------------------------------------------------------------------

/**
 * Converts a {@link CapabilityResult} into an {@link OutboundResponse} ready
 * for the Chalie IPC wire protocol.
 *
 * Serialisation rules:
 * 1. If `result.error` is set, return `{ error }` immediately (no `html`/`text`).
 * 2. If `result.html` is explicitly set, use it as the `html` wire field.
 * 3. If `result.text` begins with `<` (looks like HTML markup), promote it to
 *    the `html` wire field so Chalie renders it correctly.
 * 4. Otherwise pass `result.text` through as plain text. When neither `text`
 *    nor `html` is present, JSON-stringify the result as a fallback.
 *
 * In all non-error cases the optional `title` field is forwarded when present.
 *
 * @param result - The capability handler's return value.
 * @returns A structured {@link OutboundResponse} ready for `writeResponse`.
 */
function buildResponse(result: CapabilityResult): OutboundResponse {
  // Error short-circuit — never include content fields alongside an error.
  if (result.error !== undefined) {
    return { error: result.error };
  }

  // Optional title forwarding — only set when defined to satisfy
  // `exactOptionalPropertyTypes`.
  const withTitle = (base: OutboundResponse): OutboundResponse =>
    result.title !== undefined ? { ...base, title: result.title } : base;

  // Explicit HTML result.
  if (result.html !== undefined) {
    return withTitle({ html: result.html });
  }

  // Plain text that looks like HTML markup — promote to html.
  if (result.text !== undefined && result.text.trimStart().startsWith("<")) {
    return withTitle({ html: result.text });
  }

  // Plain text result.
  if (result.text !== undefined) {
    return withTitle({ text: result.text });
  }

  // Fallback: no text or html — JSON-stringify the whole result object so
  // callers always get something meaningful rather than an empty response.
  return withTitle({ text: JSON.stringify(result) });
}

// ---------------------------------------------------------------------------
// Poller startup helper
// ---------------------------------------------------------------------------

/**
 * Starts the background monitor poller if at least one platform is connected
 * and not in a permanently-failed auth state.
 *
 * Platforms are considered "configured" when their platform sub-object exists
 * in `state` and `authFailed` is not `true`. A platform that has failed
 * authentication will not be polled until the user reconnects via the setup
 * wizard.
 *
 * @param state - The current {@link MonitorState} loaded from disk.
 */
function maybeStartPoller(state: MonitorState): void {
  const githubReady = state.github !== undefined && state.github.authFailed !== true;
  const gitlabReady = state.gitlab !== undefined && state.gitlab.authFailed !== true;

  if (githubReady || gitlabReady) {
    startPoller(state);
  }
}

// ---------------------------------------------------------------------------
// IPC request-dispatch loop
// ---------------------------------------------------------------------------

/**
 * Runs a single IPC turn: reads one request, dispatches it, serialises the
 * result, and writes the response to stdout.
 *
 * Errors thrown by the capability handler are caught and converted to
 * `{ error }` responses so the loop continues uninterrupted:
 * - {@link ApiError} → `{ error: err.message }` (already user-friendly and
 *   platform-tagged).
 * - Plain `Error` → `{ error: err.message }`.
 * - Non-Error thrown → `{ error: "An unexpected error occurred." }`.
 *
 * @returns A promise that resolves to `true` when the turn completed
 *   successfully, or `false` when stdin closed (EOF) and the loop should exit.
 */
async function runTurn(): Promise<boolean> {
  let capabilityName: string;
  let args: Record<string, unknown>;

  try {
    const message = await readRequest();

    // EOF — stdin closed cleanly.
    if (message === null) return false;

    capabilityName = message.capability ?? "";
    args = message.params ?? {};
  } catch (err) {
    // `readRequest` throws on EOF or read errors.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EOF") || msg.includes("stdin closed")) {
      // Clean shutdown — stdin closed.
      return false;
    }
    // Transient read error — write an error response and keep looping.
    writeResponse({ error: `Failed to read request: ${msg}` });
    return true;
  }

  if (!capabilityName) {
    writeResponse({ error: "Inbound message has no `capability` field." });
    return true;
  }

  let result: CapabilityResult;
  try {
    result = await dispatch(capabilityName, args);
  } catch (err) {
    // Capability threw instead of returning an error result.
    if (err instanceof ApiError) {
      writeResponse({ error: `[${err.platform}] ${err.message}` });
    } else if (err instanceof Error) {
      writeResponse({ error: err.message });
    } else {
      writeResponse({ error: "An unexpected error occurred." });
    }
    return true;
  }

  writeResponse(buildResponse(result));
  return true;
}

/**
 * Main entry-point function.
 *
 * Registers capabilities, loads persisted state, starts the background poller
 * when platforms are configured, installs a `SIGINT` shutdown handler, and
 * enters the indefinite IPC dispatch loop.
 *
 * @returns A promise that resolves when the IPC loop exits (i.e. stdin is
 *   closed by the Chalie runtime).
 */
async function main(): Promise<void> {
  // 1. Register all capability handlers with the dispatcher.
  registerAllCapabilities();

  // 2. Load persistent monitor state from disk.
  const state = await loadState();

  // 3. Start background poller if any platform is configured.
  maybeStartPoller(state);

  // 4. SIGINT handler — flush state before the process exits.
  Deno.addSignalListener("SIGINT", () => {
    // `saveState` is async; best-effort synchronous flush is not available
    // in Deno, so we chain the save and then exit.
    saveState(getState()).finally(() => Deno.exit(0));
  });

  // 5. IPC dispatch loop — run indefinitely until stdin closes.
  while (true) {
    const shouldContinue = await runTurn();
    if (!shouldContinue) break;
  }

  // Flush state on clean EOF shutdown.
  await saveState(getState());
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await main();
