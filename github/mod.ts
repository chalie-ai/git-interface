/**
 * @module github
 *
 * Barrel re-export for the GitHub API client.
 *
 * Provides normalised wrappers around the GitHub REST API v3, returning
 * unified types from `~/shared/types.ts`. All functions throw typed
 * `ApiError` values on failure.
 *
 * @example
 * ```ts
 * import { listRepos, listPRs, getPR } from "~/github/mod.ts";
 * ```
 */

export {
  createIssue,
  createPR,
  createReview,
  getRepo,
  getPR,
  listBranches,
  listIssues,
  listPRs,
  listRepos,
  listReviews,
  listSecurityAlerts,
  listWorkflowRuns,
  mergePR,
  searchCode,
  triggerWorkflow,
  updateIssue,
} from "./client.ts";
