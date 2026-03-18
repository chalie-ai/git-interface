/**
 * @module capabilities
 *
 * Barrel re-export for all registered Chalie capability handlers.
 *
 * Each capability corresponds to an action that Chalie can invoke on
 * behalf of the user (e.g. listing PRs, triggering a pipeline).
 * Capabilities are registered via `registerCapability` from the SDK shim
 * during tool startup.
 *
 * @example
 * ```ts
 * import { registerAllCapabilities } from "~/capabilities/mod.ts";
 * registerAllCapabilities();
 * ```
 */

export { registerAllCapabilities } from "./index.ts";
