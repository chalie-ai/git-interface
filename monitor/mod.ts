/**
 * @module monitor
 *
 * Barrel re-export for the background monitor subsystem.
 *
 * The monitor subsystem manages:
 * - Persistent state (`MonitorState`) stored in `{dataDir}/monitor.json`.
 * - Polling GitHub and GitLab for new events at a configurable interval.
 * - Classifying events and emitting Chalie signals/messages accordingly.
 *
 * @example
 * ```ts
 * import { loadState, saveState, startPoller } from "~/monitor/mod.ts";
 * ```
 */

export {
  addSeenEventId,
  getState,
  isEventSeen,
  loadState,
  saveState,
} from "./store.ts";
export type {
  GitHubPlatformState,
  GitLabPlatformState,
  MonitorSettings,
  MonitorState,
} from "./store.ts";
export { setPollerSecrets, startPoller } from "./poller.ts";
