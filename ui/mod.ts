/**
 * @module ui
 *
 * Barrel re-export for UI rendering helpers.
 *
 * Provides functions that generate HTML fragments conforming to the
 * Radiant design system for use in Chalie's capability result panels.
 * Also includes the setup wizard and main dashboard components.
 *
 * @example
 * ```ts
 * import { renderDashboard, renderSetupWizard } from "~/ui/mod.ts";
 * ```
 */

export { handleSetupAction, renderSetupWizard } from "./setup-wizard.ts";
export { renderDashboard, renderEmptyState } from "./dashboard.ts";
export type { DashboardEvent, DashboardEventKind } from "./dashboard.ts";
