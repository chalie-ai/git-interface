/**
 * @module gitlab
 *
 * Barrel re-export for the GitLab API client.
 *
 * Provides normalised wrappers around the GitLab REST API v4, returning
 * unified types from `~/shared/types.ts`. All functions throw typed
 * `ApiError` values on failure.
 *
 * Project identifiers are always URL-encoded namespace paths
 * (e.g. `"owner%2Frepo"`). Use `encodeProjectPath` to convert a
 * `"owner/repo"` string to the correct format.
 *
 * @example
 * ```ts
 * import { listProjects, encodeProjectPath } from "~/gitlab/mod.ts";
 * ```
 */

// Placeholder — implementation modules will be added in subsequent tasks.
export const _gitlabModPlaceholder = {};
