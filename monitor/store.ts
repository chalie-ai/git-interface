/**
 * @module monitor/store
 *
 * Persistent state management for the background monitor subsystem.
 *
 * State is stored in `{dataDir}/monitor.json` as a JSON document. Writes
 * are performed atomically: the new state is first written to a `.tmp`
 * sibling file, then renamed over the target. This prevents a partial
 * write from leaving the state file in a corrupt state.
 *
 * ## Security note
 *
 * Raw API tokens are **never** stored in `monitor.json`. The `github.tokenRef`
 * and `gitlab.tokenRef` fields hold an opaque reference key that is passed to
 * `secrets.get()` from `@chalie/interface-sdk` at runtime to retrieve the
 * actual credential.
 *
 * ## Module-level cache
 *
 * This module maintains an in-memory copy of the most recently loaded or
 * saved state. `addSeenEventId` and `isEventSeen` operate against this
 * cache. Callers should call `loadState()` at startup and `saveState()`
 * after mutating event-ID sets to flush the cache to disk.
 *
 * @example
 * ```ts
 * import { loadState, saveState, addSeenEventId, isEventSeen } from "~/monitor/store.ts";
 *
 * const state = await loadState();
 * if (!isEventSeen("github", "evt_abc123")) {
 *   addSeenEventId("github", "evt_abc123");
 *   await saveState(state);
 * }
 * ```
 */

import { dataDir } from "../sdk-shim/ipc.ts";
import type { Platform } from "../shared/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of seen event IDs retained per platform. */
const MAX_SEEN_IDS = 5_000;

// ---------------------------------------------------------------------------
// Sub-interfaces
// ---------------------------------------------------------------------------

/**
 * Persisted state for a connected GitHub account.
 *
 * `tokenRef` is an opaque key produced by `storeSecret()` / `secrets.set()`.
 * The actual PAT is retrieved at runtime via `secrets.get(tokenRef)`.
 * No raw token value ever appears in this object.
 */
export interface GitHubPlatformState {
  /**
   * Opaque reference key used to retrieve the GitHub PAT from the secrets
   * store. Never contains the raw token value.
   */
  tokenRef: string;
  /** GitHub username of the authenticated account. */
  username: string;
  /** `owner/repo` path strings of all monitored repositories. */
  monitoredRepos: string[];
  /** ISO 8601 timestamp of the most recent successful poll. */
  lastPollAt: string;
  /**
   * Ring buffer of recently seen event IDs. Capped at {@link MAX_SEEN_IDS}
   * entries; oldest entries are evicted first.
   */
  seenEventIds: string[];
}

/**
 * Persisted state for a connected GitLab account.
 *
 * `tokenRef` is an opaque key produced by `storeSecret()` / `secrets.set()`.
 * The actual PAT is retrieved at runtime via `secrets.get(tokenRef)`.
 * No raw token value ever appears in this object.
 */
export interface GitLabPlatformState {
  /**
   * Opaque reference key used to retrieve the GitLab PAT from the secrets
   * store. Never contains the raw token value.
   */
  tokenRef: string;
  /**
   * Base URL of the GitLab instance (e.g. `"https://gitlab.com"` or a
   * self-managed URL).
   */
  baseUrl: string;
  /** GitLab username of the authenticated account. */
  username: string;
  /**
   * `owner/repo` URL-encoded path strings of all monitored projects.
   * Stored as human-readable `"owner/repo"` — URL-encoding is applied by
   * the GitLab client at call time.
   */
  monitoredRepos: string[];
  /** ISO 8601 timestamp of the most recent successful poll. */
  lastPollAt: string;
  /**
   * Ring buffer of recently seen event IDs. Capped at {@link MAX_SEEN_IDS}
   * entries; oldest entries are evicted first.
   */
  seenEventIds: string[];
}

/**
 * User-configurable notification and polling settings.
 *
 * All fields have sensible defaults applied by {@link defaultSettings}.
 */
export interface MonitorSettings {
  /**
   * How often (in minutes) to poll for new events.
   * Minimum: 2; Maximum: 30; Default: 5.
   */
  pollIntervalMinutes: number;
  /** Emit a notification when a review is requested on a PR. Default: `true`. */
  notifyOnReviewRequest: boolean;
  /** Emit a notification when a CI pipeline fails. Default: `true`. */
  notifyOnCIFailure: boolean;
  /** Emit a notification when a new security alert is raised. Default: `true`. */
  notifyOnSecurityAlert: boolean;
  /** Emit a notification when the authenticated user is @mentioned. Default: `true`. */
  notifyOnMention: boolean;
  /**
   * Branch names for which CI failures trigger notifications.
   * Default: `["main", "master"]`.
   */
  ciFailureBranches: string[];
}

/**
 * Top-level persisted state document written to `{dataDir}/monitor.json`.
 *
 * Both `github` and `gitlab` are optional so the tool works when only one
 * platform is configured. The `settings` object is always present and is
 * initialised from {@link defaultSettings} when the file does not yet exist.
 */
export interface MonitorState {
  /** State for the connected GitHub account, if configured. */
  github?: GitHubPlatformState;
  /** State for the connected GitLab account, if configured. */
  gitlab?: GitLabPlatformState;
  /** Notification and polling settings. */
  settings: MonitorSettings;
}

// ---------------------------------------------------------------------------
// Module-level state cache
// ---------------------------------------------------------------------------

/** In-memory cache of the most recently loaded or saved state. */
let _cache: MonitorState = _defaultState();

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

/**
 * Returns a fresh {@link MonitorSettings} object populated with all defaults.
 *
 * @returns A new settings object with default field values.
 */
function defaultSettings(): MonitorSettings {
  return {
    pollIntervalMinutes: 5,
    notifyOnReviewRequest: true,
    notifyOnCIFailure: true,
    notifyOnSecurityAlert: true,
    notifyOnMention: true,
    ciFailureBranches: ["main", "master"],
  };
}

/**
 * Returns a fresh {@link MonitorState} object with no platform connections
 * and all settings at their default values.
 *
 * @returns A new state object with default field values.
 */
function _defaultState(): MonitorState {
  return {
    settings: defaultSettings(),
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the state file.
 *
 * @returns Absolute path string for `{dataDir}/monitor.json`.
 */
function statePath(): string {
  return `${dataDir()}/monitor.json`;
}

/**
 * Returns the absolute path to the temporary file used during an atomic write.
 *
 * @returns Absolute path string for `{dataDir}/monitor.json.tmp`.
 */
function tempStatePath(): string {
  return `${statePath()}.tmp`;
}

// ---------------------------------------------------------------------------
// Public API — state persistence
// ---------------------------------------------------------------------------

/**
 * Loads monitor state from `{dataDir}/monitor.json` and updates the
 * module-level cache.
 *
 * If the file does not exist, cannot be read, or contains invalid JSON,
 * the default state is returned without throwing. Any stored settings fields
 * are merged on top of the defaults so that newly-added settings keys are
 * always present even when reading an older state file.
 *
 * @returns A promise that resolves to the current {@link MonitorState}.
 *
 * @example
 * ```ts
 * const state = await loadState();
 * console.log(state.settings.pollIntervalMinutes); // 5
 * ```
 */
export async function loadState(): Promise<MonitorState> {
  let parsed: Partial<MonitorState>;

  try {
    const raw = await Deno.readTextFile(statePath());
    parsed = JSON.parse(raw) as Partial<MonitorState>;
  } catch {
    // File missing or unreadable — start fresh.
    _cache = _defaultState();
    return _cache;
  }

  const state: MonitorState = {
    ...(parsed.github !== undefined ? { github: parsed.github } : {}),
    ...(parsed.gitlab !== undefined ? { gitlab: parsed.gitlab } : {}),
    settings: {
      ...defaultSettings(),
      ...(parsed.settings ?? {}),
    },
  };

  _cache = state;
  return state;
}

/**
 * Atomically writes `state` to `{dataDir}/monitor.json` and updates the
 * module-level cache.
 *
 * The write is performed by first writing the serialised JSON to a `.tmp`
 * sibling file, then calling `Deno.rename()` to replace the target. On
 * POSIX systems `rename(2)` is atomic within the same filesystem; this
 * prevents a partial write from corrupting the live state file.
 *
 * The data directory is created recursively if it does not yet exist.
 *
 * @param state - The {@link MonitorState} to persist.
 * @returns A promise that resolves when the file has been successfully written.
 * @throws {Error} If the directory cannot be created or the file cannot be
 *   written or renamed.
 *
 * @example
 * ```ts
 * const state = await loadState();
 * state.settings.pollIntervalMinutes = 10;
 * await saveState(state);
 * ```
 */
export async function saveState(state: MonitorState): Promise<void> {
  const dir = dataDir();
  await Deno.mkdir(dir, { recursive: true });

  const json = JSON.stringify(state, null, 2);
  await Deno.writeTextFile(tempStatePath(), json);
  await Deno.rename(tempStatePath(), statePath());

  _cache = state;
}

// ---------------------------------------------------------------------------
// Public API — event-ID deduplication
// ---------------------------------------------------------------------------

/**
 * Records a platform event ID as seen in the module-level cache.
 *
 * If the platform's state object does not yet exist in the cache, this
 * function is a no-op (the platform has not been configured). Call
 * {@link saveState} after this function to flush the updated ID list to disk.
 *
 * The `seenEventIds` array is trimmed to the most recent
 * {@link MAX_SEEN_IDS} entries (5,000) by removing entries from the front
 * (oldest first) when the cap is exceeded.
 *
 * @param platform - The platform (`"github"` or `"gitlab"`) the event
 *   originates from.
 * @param id - The opaque event ID string to record.
 *
 * @example
 * ```ts
 * addSeenEventId("github", "evt_abc123");
 * await saveState(await loadState()); // flush to disk
 * ```
 */
export function addSeenEventId(platform: Platform, id: string): void {
  const platformState = _cache[platform];
  if (platformState === undefined) return;

  platformState.seenEventIds.push(id);

  if (platformState.seenEventIds.length > MAX_SEEN_IDS) {
    // Evict oldest entries from the front. splice(0, excess) is O(n) but
    // MAX_SEEN_IDS is small enough that this is acceptable.
    const excess = platformState.seenEventIds.length - MAX_SEEN_IDS;
    platformState.seenEventIds.splice(0, excess);
  }
}

/**
 * Returns `true` if the given event ID has already been recorded for
 * `platform` in the module-level cache.
 *
 * @param platform - The platform (`"github"` or `"gitlab"`) to check.
 * @param id - The opaque event ID string to look up.
 * @returns `true` if the ID is present in the platform's `seenEventIds`
 *   list; `false` if the ID is unseen or the platform is not configured.
 *
 * @example
 * ```ts
 * if (!isEventSeen("github", eventId)) {
 *   // process event
 *   addSeenEventId("github", eventId);
 * }
 * ```
 */
export function isEventSeen(platform: Platform, id: string): boolean {
  const platformState = _cache[platform];
  if (platformState === undefined) return false;
  return platformState.seenEventIds.includes(id);
}

/**
 * Returns a read-only snapshot of the current module-level state cache.
 *
 * Primarily intended for testing and diagnostics. Mutations to the returned
 * object will affect the cache — callers should treat the return value as
 * read-only.
 *
 * @returns The currently cached {@link MonitorState}.
 */
export function getState(): MonitorState {
  return _cache;
}
