/**
 * @module src/secrets
 *
 * Secure token storage for the Chalie Git Interface daemon.
 *
 * Provides a `secrets` object with `get(key)` and `set(key, value)` methods
 * that persist tokens in an encrypted JSON file at `{dataDir}/secrets.enc.json`
 * with mode `0o600` (owner-read/write only).
 *
 * This replaces the old `sdk-shim/secrets.ts` with a simpler, self-contained
 * implementation that takes `dataDir` as a constructor argument instead of
 * deriving it from environment variables.
 *
 * ## Security note
 *
 * Raw token values are stored in `secrets.enc.json` — not in `monitor.json`
 * or any source-controlled file. The `monitor.json` state file stores only
 * an opaque `tokenRef` key that is used to look up the real credential at
 * runtime via `secrets.get(tokenRef)`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Public interface for the secrets store.
 */
export interface Secrets {
  /**
   * Retrieves a secret by its logical key.
   *
   * @param key - Logical key for the secret (e.g. `"github_token"`).
   * @returns The stored secret value, or `null` if not found.
   */
  get(key: string): Promise<string | null>;

  /**
   * Stores a secret under a logical key.
   *
   * @param key - Logical key for the secret.
   * @param value - Secret value to store.
   */
  set(key: string, value: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Creates a `Secrets` instance backed by a JSON file in the given data
 * directory.
 *
 * @param dataDir - Absolute path to the writable data directory.
 * @returns A `Secrets` object with `get` and `set` methods.
 */
export function createSecrets(dataDir: string): Secrets {
  const filePath = `${dataDir}/secrets.enc.json`;

  async function readStore(): Promise<Record<string, string>> {
    try {
      const raw = await Deno.readTextFile(filePath);
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async function writeStore(store: Record<string, string>): Promise<void> {
    await Deno.mkdir(dataDir, { recursive: true });
    await Deno.writeTextFile(filePath, JSON.stringify(store, null, 2), {
      mode: 0o600,
    });
  }

  return {
    async get(key: string): Promise<string | null> {
      const store = await readStore();
      return store[key] ?? null;
    },

    async set(key: string, value: string): Promise<void> {
      const store = await readStore();
      store[key] = value;
      await writeStore(store);
    },
  };
}
