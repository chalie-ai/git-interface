/**
 * @module main
 *
 * Entry point for the Chalie Git Interface tool.
 *
 * Responsibilities at startup:
 * 1. Register all capabilities with the SDK shim's dispatcher.
 * 2. Advertise the tool's scopes (signal/message topics) to the runtime.
 * 3. Start the background monitor poller (if in embodiment/daemon mode).
 * 4. Enter the IPC event loop, processing capability invocations until
 *    stdin is closed.
 *
 * ## Execution modes
 *
 * | `CHALIE_MODE` env var | Behaviour |
 * |-----------------------|-----------|
 * | `"one-shot"` (default) | Handle a single IPC turn then exit. |
 * | `"interactive"` | Process up to 10 turns / 120s per turn. |
 * | `"daemon"` | Run indefinitely, polling and emitting signals. |
 *
 * The mode is set by the Chalie runtime; this file honours it by
 * configuring the event loop accordingly.
 *
 * @example Start locally for development:
 * ```sh
 * deno task dev
 * ```
 */

import { runEventLoop } from "@chalie/interface-sdk";
import type { Scopes } from "@chalie/interface-sdk";

// Re-export placeholders keep the barrel imports hot during
// scaffolding; they will be replaced with real registrations.
import { _capabilitiesModPlaceholder } from "~/capabilities/mod.ts";
import { _monitorModPlaceholder } from "~/monitor/mod.ts";

// Silence "unused import" linter warnings during scaffolding phase.
void _capabilitiesModPlaceholder;
void _monitorModPlaceholder;

// ---------------------------------------------------------------------------
// Scope declaration
// ---------------------------------------------------------------------------

/**
 * Declares the signal and message topics emitted by this tool.
 * Provided to `runEventLoop` so the Chalie runtime can configure routing
 * before the first turn begins.
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point. Registers capabilities, starts ancillary services,
 * and enters the IPC event loop.
 */
async function main(): Promise<void> {
  // TODO (task: capability-registration): call registerAllCapabilities()
  // TODO (task: monitor-poller): start background poller in daemon mode

  await runEventLoop(SCOPES);
}

// Run.
await main();
