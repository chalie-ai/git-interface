/**
 * @module shared/types
 *
 * Unified type definitions shared across GitHub and GitLab API clients,
 * the monitor subsystem, and capability handlers. All external API
 * responses are normalised to these types before use.
 */

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** The source code hosting platform a resource originates from. */
export type Platform = "github" | "gitlab";

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * A normalised representation of a remote repository on any supported
 * platform.
 */
export interface Repo {
  /** Opaque platform-scoped unique identifier. */
  id: string;
  /** Hosting platform this repository belongs to. */
  platform: Platform;
  /** Canonical `owner/repo` path string. */
  fullName: string;
  /** Web URL of the repository. */
  url: string;
  /** Name of the default branch (e.g. `"main"`). */
  defaultBranch: string;
  /** Whether the repository is private/internal. */
  isPrivate: boolean;
  /** Primary programming language, if detected. */
  language?: string;
  /** Short description of the repository. */
  description?: string;
  /** Total number of stars/stargazers. */
  starCount: number;
  /** Number of currently open issues. */
  openIssueCount: number;
  /** Number of currently open pull/merge requests. */
  openPRCount: number;
}

// ---------------------------------------------------------------------------
// Pull / Merge Request
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a pull or merge request.
 *
 * Note: draft status is represented separately via `isDraft` so that
 * an open draft PR can be distinguished from an open non-draft PR
 * without losing state information.
 */
export type PRState = "open" | "closed" | "merged";

/**
 * Aggregated review decision for a pull request.
 *
 * - `"approved"` — all required reviewers have approved.
 * - `"changes_requested"` — at least one reviewer requested changes.
 * - `"review_required"` — review has been requested but not yet submitted.
 */
export type ReviewDecision = "approved" | "changes_requested" | "review_required";

/**
 * CI/CD pipeline status associated with a pull request's head commit.
 */
export type CIStatus = "pending" | "running" | "success" | "failed" | "cancelled";

/**
 * A normalised pull request (GitHub) or merge request (GitLab).
 */
export interface PullRequest {
  /** Opaque platform-scoped unique identifier. */
  id: string;
  /** Hosting platform this PR originates from. */
  platform: Platform;
  /** `owner/repo` path of the containing repository. */
  repo: string;
  /** Sequential number within the repository. */
  number: number;
  /** PR title. */
  title: string;
  /** PR body / description, if present. */
  body?: string;
  /**
   * Lifecycle state of the PR.
   * Draft status is encoded separately in `isDraft`; a draft PR will
   * have `state: "open"` and `isDraft: true`.
   */
  state: PRState;
  /** Whether the PR is currently in draft / work-in-progress mode. */
  isDraft: boolean;
  /** Username of the PR author. */
  author: string;
  /** Usernames of all assigned reviewers. */
  assignees: string[];
  /** Usernames of requested reviewers. */
  reviewers: string[];
  /** Labels applied to the PR. */
  labels: string[];
  /** Branch the PR proposes changes from. */
  sourceBranch: string;
  /** Branch the PR targets. */
  targetBranch: string;
  /** Web URL of the PR. */
  url: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
  /** Status of the most recent CI run against this PR's head, if known. */
  ciStatus?: CIStatus;
  /** Platform-specific mergeable state string, if available. */
  mergeableState?: string;
  /** Aggregated review decision, if available. */
  reviewDecision?: ReviewDecision;
  /** Total number of review comments. */
  commentCount: number;
  /** Lines added in this PR. */
  additions: number;
  /** Lines deleted in this PR. */
  deletions: number;
  /** Number of files changed in this PR. */
  changedFiles: number;
}

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------

/**
 * A repository branch and its most recent commit metadata.
 */
export interface Branch {
  /** Branch name. */
  name: string;
  /** Whether branch protection rules are enabled. */
  isProtected: boolean;
  /** SHA of the most recent commit on this branch. */
  lastCommitSha: string;
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a repository issue.
 */
export type IssueState = "open" | "closed";

/**
 * A normalised repository issue.
 */
export interface Issue {
  /** Opaque platform-scoped unique identifier. */
  id: string;
  /** Hosting platform this issue originates from. */
  platform: Platform;
  /** `owner/repo` path of the containing repository. */
  repo: string;
  /** Sequential number within the repository. */
  number: number;
  /** Issue title. */
  title: string;
  /** Issue body / description, if present. */
  body?: string;
  /** Lifecycle state. */
  state: IssueState;
  /** Username of the issue author. */
  author: string;
  /** Usernames of people assigned to this issue. */
  assignees: string[];
  /** Labels applied to the issue. */
  labels: string[];
  /** Web URL of the issue. */
  url: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
  /** Number of comments on the issue. */
  commentCount: number;
}

// ---------------------------------------------------------------------------
// Pipeline / Workflow Run
// ---------------------------------------------------------------------------

/**
 * Execution status of a CI/CD pipeline or workflow run.
 */
export type PipelineStatus = "pending" | "running" | "success" | "failed" | "cancelled";

/**
 * A normalised CI/CD pipeline run (GitHub Actions run or GitLab pipeline).
 */
export interface Pipeline {
  /** Opaque platform-scoped unique identifier. */
  id: string;
  /** Hosting platform this pipeline originates from. */
  platform: Platform;
  /** `owner/repo` path of the containing repository. */
  repo: string;
  /** Pipeline / workflow name. */
  name: string;
  /** Execution status. */
  status: PipelineStatus;
  /** Branch or ref the pipeline ran against. */
  branch: string;
  /** SHA of the commit the pipeline ran against. */
  commitSha: string;
  /** Web URL of the pipeline run. */
  url: string;
  /** ISO 8601 start timestamp, if available. */
  startedAt?: string;
  /** ISO 8601 finish timestamp, if available. */
  finishedAt?: string;
  /** Wall-clock duration in seconds, if available. */
  durationSeconds?: number;
}

// ---------------------------------------------------------------------------
// Security Alert
// ---------------------------------------------------------------------------

/**
 * Severity level of a security advisory or vulnerability.
 */
export type AlertSeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * A normalised Dependabot / GitLab dependency vulnerability alert.
 */
export interface SecurityAlert {
  /** Opaque platform-scoped unique identifier. */
  id: string;
  /** Hosting platform this alert originates from. */
  platform: Platform;
  /** `owner/repo` path of the containing repository. */
  repo: string;
  /** Advisory or vulnerability title. */
  title: string;
  /** Alert severity. */
  severity: AlertSeverity;
  /** Affected dependency package name. */
  packageName: string;
  /** Vulnerable version range string. */
  vulnerableRange: string;
  /** Fixed version string, if a patch is available. */
  fixedVersion?: string;
  /** Web URL of the alert. */
  url: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * State of a code review submission.
 *
 * Note: GitLab does not have a native `changes_requested` state.
 * When normalising GitLab approvals, `"approved"` is used for explicit
 * approvals; `"comment"` is used for all other review notes.
 */
export type ReviewState = "approved" | "changes_requested" | "comment" | "dismissed";

/**
 * A normalised pull-request / merge-request code review.
 */
export interface Review {
  /** Opaque platform-scoped unique identifier. */
  id: string;
  /** Hosting platform this review originates from. */
  platform: Platform;
  /** Number of the PR/MR this review belongs to. */
  prNumber: number;
  /** `owner/repo` path of the containing repository. */
  repo: string;
  /** Username of the reviewer. */
  reviewer: string;
  /** Review state. */
  state: ReviewState;
  /** Review body text, if present. */
  body?: string;
  /** ISO 8601 timestamp of submission. */
  submittedAt: string;
  /** Web URL of the review. */
  url: string;
}

// ---------------------------------------------------------------------------
// Comment
// ---------------------------------------------------------------------------

/**
 * A normalised issue or pull-request comment.
 */
export interface Comment {
  /** Opaque platform-scoped unique identifier. */
  id: string;
  /** Hosting platform this comment originates from. */
  platform: Platform;
  /** `owner/repo` path of the containing repository. */
  repo: string;
  /** Number of the issue/PR this comment belongs to. */
  issueNumber: number;
  /** Username of the comment author. */
  author: string;
  /** Comment body text. */
  body: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
  /** Web URL of the comment. */
  url: string;
}

// ---------------------------------------------------------------------------
// Code Search
// ---------------------------------------------------------------------------

/**
 * A single result returned from a cross-repository code search.
 */
export interface CodeResult {
  /** Repository-relative file path. */
  path: string;
  /** `owner/repo` path of the containing repository. */
  repo: string;
  /** Hosting platform this result originates from. */
  platform: Platform;
  /** Web URL of the file (pointing at the matching line if possible). */
  url: string;
  /** Short matched code snippet / context fragment. */
  fragment: string;
  /** 1-based line number of the match, if available. */
  lineNumber?: number;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Discriminated error category for API client failures.
 *
 * - `auth_failed` — 401: token is missing, invalid, or expired.
 * - `forbidden` — 403: authenticated but insufficient permissions.
 * - `not_found` — 404: resource does not exist or is hidden.
 * - `rate_limited` — 429 / 403 with exhausted rate limit.
 * - `validation` — 422: request payload rejected by the server.
 * - `server_error` — 5xx: transient upstream failure.
 * - `network` — connection/timeout failure before receiving a response.
 */
export type ApiErrorCode =
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "validation"
  | "server_error"
  | "network";

/**
 * Payload shape carried by every {@link ApiError} instance.
 *
 * This interface defines the structured data attached to a thrown
 * `ApiError`. Consumers should switch on `code` to decide how to handle
 * each category (e.g. surface `auth_failed` as a "reconnect" prompt,
 * back off on `rate_limited` using `retryAfter`).
 *
 * @see ApiError
 */
export interface ApiErrorPayload {
  /** Platform that produced the error. */
  platform: Platform;
  /** HTTP status code, or 0 for network-level failures. */
  status: number;
  /** Discriminated error category. */
  code: ApiErrorCode;
  /** User-friendly English message describing the failure. */
  message: string;
  /**
   * Number of seconds to wait before retrying, populated when
   * `code === "rate_limited"` and the server provided a `Retry-After`
   * or `RateLimit-Reset` header.
   */
  retryAfter?: number;
}

/**
 * Throwable API error class used by GitHub and GitLab client functions.
 *
 * `ApiError` serves a dual role in TypeScript:
 * - **Payload shape** — the class's structural type acts as an interface,
 *   so `ApiError` can be used as a type annotation wherever the payload
 *   shape is needed.
 * - **Throwable class** — extends the built-in `Error` so instances can be
 *   thrown, caught, and checked with `instanceof ApiError`.
 *
 * @example
 * ```ts
 * throw new ApiError({
 *   platform: "github",
 *   status: 401,
 *   code: "auth_failed",
 *   message: "GitHub token is invalid or expired. Please reconnect in settings.",
 * });
 * ```
 *
 * @example
 * ```ts
 * try {
 *   await listRepos(token);
 * } catch (err) {
 *   if (err instanceof ApiError && err.code === "rate_limited") {
 *     await delay((err.retryAfter ?? 60) * 1_000);
 *   }
 * }
 * ```
 */
export class ApiError extends Error implements ApiErrorPayload {
  /** Platform that produced the error. */
  readonly platform: Platform;

  /** HTTP status code, or 0 for network-level failures. */
  readonly status: number;

  /** Discriminated error category. */
  readonly code: ApiErrorCode;

  /**
   * Number of seconds to wait before retrying, populated when
   * `code === "rate_limited"` and the server provided a `Retry-After`
   * or `RateLimit-Reset` header.
   */
  readonly retryAfter?: number;

  /**
   * Construct a new `ApiError` from a typed payload object.
   *
   * @param payload - Structured error data conforming to {@link ApiErrorPayload}.
   */
  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.name = "ApiError";
    this.platform = payload.platform;
    this.status = payload.status;
    this.code = payload.code;
    this.retryAfter = payload.retryAfter;
  }
}
