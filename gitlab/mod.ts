/**
 * @module gitlab
 *
 * Barrel re-export for the GitLab API client.
 *
 * Provides normalised wrappers around the GitLab REST API v4, returning
 * unified types from `~/shared/types.ts`. All functions throw typed
 * `ApiError` values on failure.
 *
 * ## Project identifiers
 * Project identifiers are always URL-encoded namespace paths
 * (e.g. `"owner%2Frepo"`). Use {@link encodeProjectPath} to convert a
 * `"owner/repo"` string to the correct format.
 *
 * ## Rate limiting
 * Use {@link isRateLimitLow} to check whether `RateLimit-Remaining` has
 * dropped below 50 before issuing non-critical requests.
 *
 * @example
 * ```ts
 * import {
 *   listProjects,
 *   listMRs,
 *   encodeProjectPath,
 *   isRateLimitLow,
 * } from "~/gitlab/mod.ts";
 *
 * const projectId = encodeProjectPath("my-org/my-repo");
 * const prs = await listMRs(token, projectId, { updatedAfter: since });
 * ```
 */

export {
  createIssue,
  createMR,
  createMRNote,
  encodeProjectPath,
  getMR,
  getProject,
  getRateLimitState,
  isRateLimitLow,
  listBranches,
  listIssues,
  listMRApprovals,
  listMRs,
  listPipelines,
  listProjects,
  mergeMR,
  searchCode,
  triggerPipeline,
  updateIssue,
} from "./client.ts";
