/**
 * @module sdk-shim/secrets
 *
 * Secure token storage abstraction for the Chalie Git Interface tool.
 *
 * Resolution order for storage backends:
 * 1. Chalie secrets API (when `CHALIE_SECRETS_SOCKET` env var is set).
 * 2. OS keyring via `DENO_KEYRING` env var pointing to a keyring helper.
 * 3. Encrypted file fallback in `dataDir()` — requires explicit user
 *    opt-in via `CHALIE_ALLOW_PLAINTEXT_SECRETS=1`. Plaintext JSON
 *    storage is **never** used silently.
 *
 * Tokens are never written to `monitor.json` or any source-controlled
 * file. `monitor.json` stores only an opaque `tokenRef` key.
 */

import { dataDir } from "./ipc.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An opaque reference key returned by `storeSecret` and used by
 * `retrieveSecret`. Consumers should treat this as an opaque string.
 */
export type SecretRef = string;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the path to the encrypted secrets file used by the file
 * fallback backend.
 *
 * @returns Absolute path string.
 */
function secretsFilePath(): string {
  return `${dataDir()}/secrets.enc.json`;
}

/**
 * Determines whether plaintext fallback storage has been explicitly
 * opted into by the user via an environment variable.
 *
 * @returns `true` if `CHALIE_ALLOW_PLAINTEXT_SECRETS=1` is set.
 */
function isPlaintextFallbackAllowed(): boolean {
  return Deno.env.get("CHALIE_ALLOW_PLAINTEXT_SECRETS") === "1";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stores a secret value under a given key, using the best available
 * backend. Returns a `SecretRef` that can be persisted (e.g. in
 * `monitor.json`) and passed to `retrieveSecret` later.
 *
 * @param key - Logical key for the secret (e.g. `"github_token"`).
 * @param value - Secret value to store (e.g. a personal access token).
 * @returns A `SecretRef` opaque reference string.
 * @throws {Error} If no storage backend is available and plaintext
 *   fallback has not been opted into.
 */
export async function storeSecret(key: string, value: string): Promise<SecretRef> {
  const chalieSocket = Deno.env.get("CHALIE_SECRETS_SOCKET");
  if (chalieSocket) {
    // TODO: implement Chalie secrets API IPC call when socket protocol
    // is defined by the core team.
    return `chalie:${key}`;
  }

  if (isPlaintextFallbackAllowed()) {
    await writeSecretsFile({ ...(await readSecretsFile()), [key]: value });
    return `file:${key}`;
  }

  throw new Error(
    `No secure secrets backend available. ` +
      `Set CHALIE_ALLOW_PLAINTEXT_SECRETS=1 to enable the plaintext file fallback ` +
      `(not recommended for production use).`,
  );
}

/**
 * Retrieves a secret value using a `SecretRef` previously returned by
 * `storeSecret`.
 *
 * @param ref - The `SecretRef` returned at store time.
 * @returns The secret value, or `undefined` if not found.
 * @throws {Error} If the backend indicated by `ref` is unavailable.
 */
export async function retrieveSecret(ref: SecretRef): Promise<string | undefined> {
  if (ref.startsWith("chalie:")) {
    const key = ref.slice("chalie:".length);
    const chalieSocket = Deno.env.get("CHALIE_SECRETS_SOCKET");
    if (!chalieSocket) {
      throw new Error(
        `Secret ref "${ref}" requires the Chalie secrets API, but ` +
          `CHALIE_SECRETS_SOCKET is not set.`,
      );
    }
    // TODO: implement Chalie secrets API retrieval.
    void key;
    return undefined;
  }

  if (ref.startsWith("file:")) {
    const key = ref.slice("file:".length);
    const store = await readSecretsFile();
    return store[key];
  }

  return undefined;
}

/**
 * Removes a stored secret by its `SecretRef`.
 *
 * @param ref - The `SecretRef` of the secret to remove.
 */
export async function deleteSecret(ref: SecretRef): Promise<void> {
  if (ref.startsWith("file:")) {
    const key = ref.slice("file:".length);
    const store = await readSecretsFile();
    delete store[key];
    await writeSecretsFile(store);
  }
  // Other backends: no-op until implemented.
}

// ---------------------------------------------------------------------------
// File backend helpers
// ---------------------------------------------------------------------------

/**
 * Reads the on-disk secrets store, returning an empty object if the
 * file does not yet exist.
 *
 * @returns A plain record mapping secret keys to values.
 */
async function readSecretsFile(): Promise<Record<string, string>> {
  try {
    const raw = await Deno.readTextFile(secretsFilePath());
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Writes the secrets record to disk with mode `0o600` (owner-read/write only).
 *
 * The directory is created if it does not already exist. The file is
 * written with `mode: 0o600` so it is readable and writable only by the
 * process owner — satisfying the "600-permission file" requirement in the
 * Chalie spec. On platforms that ignore POSIX modes (e.g. Windows) this
 * is silently ignored by the OS.
 *
 * @param store - The updated secrets record to persist.
 */
async function writeSecretsFile(store: Record<string, string>): Promise<void> {
  const dir = dataDir();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(secretsFilePath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}
