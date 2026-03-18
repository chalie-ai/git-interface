/**
 * @module github/client
 *
 * GitHub REST API v3 client with typed error handling, exponential-backoff
 * retry logic, and Link-header pagination.
 *
 * All public functions accept a GitHub personal access token as their first
 * argument and return unified types from `~/shared/types.ts`. Every non-2xx
 * response is mapped to a typed {@link ApiError} before being thrown.
 *
 * ## Retry policy
 * Transient errors (`server_error`, `network`) are retried up to 2 times with
 * exponential back-off: 1 s then 3 s. 4xx errors are never retried.
 *
 * ## Pagination
 * List functions follow GitHub's `Link: <url>; rel="next"` header.
 * The `maxPages` parameter (default 3, hard cap 10) controls how many pages
 * are fetched before stopping. Pass a higher value for repos/users with many
 * resources.
 */

import {
  ApiError,
  type ApiErrorPayload,
  type Branch,
  type CIStatus,
  type CodeResult,
  type Issue,
  type Pipeline,
  type PRState,
  type PullRequest,
  type Repo,
  type Review,
  type ReviewDecision,
  type ReviewState,
  type SecurityAlert,
} from "~/shared/mod.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** Hard upper limit on pages fetched in a single paginated call. */
const MAX_PAGES_LIMIT = 10;
/** Default number of pages fetched when callers omit `maxPages`. */
const DEFAULT_MAX_PAGES = 3;
/** Maximum number of retry attempts for transient errors (excludes initial attempt). */
const MAX_RETRIES = 2;

// ---------------------------------------------------------------------------
// Internal raw GitHub API response shapes
// (private — never exported; always narrowed before use)
// ---------------------------------------------------------------------------

interface RawGHUser {
  login: string;
}

interface RawGHLabel {
  name: string;
}

interface RawGHCommitRef {
  ref: string;
  sha: string;
}

interface RawGHRepo {
  id: number;
  full_name: string;
  html_url: string;
  default_branch: string;
  private: boolean;
  language: string | null;
  description: string | null;
  stargazers_count: number;
  open_issues_count: number;
}

interface RawGHPR {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  user: RawGHUser | null;
  assignees: RawGHUser[];
  requested_reviewers: RawGHUser[];
  labels: RawGHLabel[];
  head: RawGHCommitRef;
  base: RawGHCommitRef;
  html_url: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  mergeable_state?: string;
  comments: number;
  review_comments: number;
  /** Only present on individual-PR endpoint, not list endpoint. */
  additions?: number;
  /** Only present on individual-PR endpoint, not list endpoint. */
  deletions?: number;
  /** Only present on individual-PR endpoint, not list endpoint. */
  changed_files?: number;
}

interface RawGHIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: RawGHUser | null;
  assignees: RawGHUser[];
  labels: RawGHLabel[];
  html_url: string;
  created_at: string;
  updated_at: string;
  comments: number;
  /**
   * Presence of this key indicates the item is a pull request, not a true
   * issue. Callers must filter these out before normalising.
   */
  pull_request?: unknown;
}

interface RawGHBranch {
  name: string;
  protected: boolean;
  commit: { sha: string };
}

interface RawGHWorkflowRun {
  id: number;
  name: string | null;
  /** "queued" | "in_progress" | "completed" */
  status: string;
  /** null while in progress; "success"|"failure"|"cancelled"|"neutral"|"skipped"|"timed_out"|"action_required" when completed */
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  html_url: string;
  run_started_at: string | null;
  updated_at: string;
}

interface RawGHWorkflowRunsResponse {
  workflow_runs: RawGHWorkflowRun[];
}

interface RawGHReview {
  id: number;
  user: RawGHUser | null;
  /** "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING" */
  state: string;
  body: string;
  submitted_at: string;
  html_url: string;
}

interface RawGHVulnerability {
  vulnerable_version_range: string;
  first_patched_version: { identifier: string } | null;
}

interface RawGHDependabotAlert {
  number: number;
  dependency: {
    package: { name: string };
  };
  security_advisory: {
    summary: string;
    severity: string;
    vulnerabilities: RawGHVulnerability[];
  };
  html_url: string;
  created_at: string;
}

interface RawGHCodeTextMatch {
  fragment: string;
}

interface RawGHCodeSearchItem {
  path: string;
  repository: { full_name: string };
  html_url: string;
  text_matches?: RawGHCodeTextMatch[];
}

interface RawGHCodeSearchResponse {
  items: RawGHCodeSearchItem[];
}

interface RawGHCheckRun {
  /** "queued" | "in_progress" | "completed" */
  status: string;
  /** null while in progress */
  conclusion: string | null;
}

interface RawGHCheckRunsResponse {
  check_runs: RawGHCheckRun[];
}

interface RawGHMergeResponse {
  merged: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Internal request options
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: string;
  body?: string;
  /** Additional headers that override or supplement the defaults. */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Returns a promise that resolves after `ms` milliseconds.
 *
 * @param ms - Duration in milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns the retry back-off delay for a given attempt index.
 *
 * @param attempt - Zero-based retry index (0 = first retry, 1 = second retry).
 * @returns Delay in milliseconds: 1 000 ms for attempt 0, 3 000 ms otherwise.
 */
function retryDelayMs(attempt: number): number {
  return attempt === 0 ? 1_000 : 3_000;
}

/**
 * Parses a GitHub `Link` response header and returns the URL tagged with
 * `rel="next"`, or `undefined` when no next page exists.
 *
 * Expected format: `<https://api.github.com/…>; rel="next", <…>; rel="last"`
 *
 * @param header - Raw value of the `Link` HTTP response header.
 * @returns Next-page URL string, or `undefined`.
 */
function parseLinkNext(header: string): string | undefined {
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    const url = match?.[1];
    if (url !== undefined) return url;
  }
  return undefined;
}

/**
 * Maps a raw severity string from the GitHub Dependabot API to the
 * normalised `AlertSeverity` union type.
 *
 * Unknown values fall back to `"info"`.
 *
 * @param raw - Severity string from the GitHub API (case-insensitive).
 * @returns Normalised `AlertSeverity` value.
 */
function mapSeverity(raw: string): SecurityAlert["severity"] {
  switch (raw.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "info";
  }
}

// ---------------------------------------------------------------------------
// Error building
// ---------------------------------------------------------------------------

/**
 * Builds a typed `ApiError` from a non-OK GitHub HTTP response.
 *
 * Reads the response body to extract GitHub's `message` field. Checks
 * `X-RateLimit-Remaining` on 403 responses to distinguish rate-limit
 * exhaustion from permission errors. Populates `retryAfter` from
 * `X-RateLimit-Reset` or `Retry-After` headers where applicable.
 *
 * @param resp - The failed fetch `Response` object (must be non-2xx).
 * @returns A fully populated `ApiError` instance ready to throw.
 */
async function buildApiError(resp: Response): Promise<ApiError> {
  const { status } = resp;
  let bodyMsg = "";
  try {
    const text = await resp.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    if (typeof json["message"] === "string") {
      bodyMsg = json["message"];
    }
  } catch {
    // Ignore body parse failures — bodyMsg stays empty.
  }

  if (status === 401) {
    return new ApiError({
      platform: "github",
      status,
      code: "auth_failed",
      message: "GitHub token is invalid or expired. Please reconnect in settings.",
    });
  }

  if (status === 403) {
    const remaining = resp.headers.get("X-RateLimit-Remaining");
    if (remaining === "0") {
      const resetHeader = resp.headers.get("X-RateLimit-Reset");
      const retryAfter = resetHeader !== null
        ? Math.max(0, Number(resetHeader) - Math.floor(Date.now() / 1_000))
        : undefined;
      const payload: ApiErrorPayload = {
        platform: "github",
        status,
        code: "rate_limited",
        message: "GitHub API rate limit exhausted. Requests will resume automatically.",
      };
      if (retryAfter !== undefined) payload.retryAfter = retryAfter;
      return new ApiError(payload);
    }
    return new ApiError({
      platform: "github",
      status,
      code: "forbidden",
      message: bodyMsg || "Access forbidden. You may not have permission to access this resource.",
    });
  }

  if (status === 404) {
    return new ApiError({
      platform: "github",
      status,
      code: "not_found",
      message: bodyMsg || "Resource not found.",
    });
  }

  if (status === 422) {
    return new ApiError({
      platform: "github",
      status,
      code: "validation",
      message: bodyMsg || "Request validation failed.",
    });
  }

  if (status === 429) {
    const retryAfterHeader = resp.headers.get("Retry-After");
    const retryAfter = retryAfterHeader !== null ? Number(retryAfterHeader) : undefined;
    const payload: ApiErrorPayload = {
      platform: "github",
      status,
      code: "rate_limited",
      message: "GitHub API secondary rate limit exceeded.",
    };
    if (retryAfter !== undefined) payload.retryAfter = retryAfter;
    return new ApiError(payload);
  }

  // 5xx and any other unexpected status codes.
  return new ApiError({
    platform: "github",
    status,
    code: "server_error",
    message: bodyMsg || `GitHub server error (HTTP ${status}).`,
  });
}

// ---------------------------------------------------------------------------
// Core HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Performs a single authenticated GitHub API request, retrying transient
 * errors (5xx responses and network failures) with exponential back-off.
 *
 * Retries up to {@link MAX_RETRIES} times (1 s then 3 s delay). 4xx errors
 * are never retried. On a 204 No Content response, returns an empty object
 * cast to `T`.
 *
 * @typeParam T - Expected shape of the parsed JSON response body.
 * @param token - GitHub personal access token.
 * @param url - Fully-qualified request URL.
 * @param opts - Optional method, body, and header overrides.
 * @returns Tuple of `[parsedBody, responseHeaders]`.
 * @throws `ApiError` for all non-retryable errors and after retries are exhausted.
 */
async function request<T>(
  token: string,
  url: string,
  opts?: RequestOptions,
): Promise<[T, Headers]> {
  let lastError: ApiError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await delay(retryDelayMs(attempt - 1));
    }

    let resp: Response;
    try {
      const mergedHeaders: Record<string, string> = {
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "Accept": "application/vnd.github+json",
        ...(opts?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts?.headers ?? {}),
      };
      const fetchInit: RequestInit = {
        method: opts?.method ?? "GET",
        headers: mergedHeaders,
        ...(opts?.body !== undefined ? { body: opts.body } : {}),
      };
      resp = await fetch(url, fetchInit);
    } catch (err) {
      const networkErr = new ApiError({
        platform: "github",
        status: 0,
        code: "network",
        message: `Network error contacting GitHub: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      if (attempt < MAX_RETRIES) {
        lastError = networkErr;
        continue;
      }
      throw networkErr;
    }

    if (!resp.ok) {
      const apiErr = await buildApiError(resp);
      if (apiErr.code === "server_error" && attempt < MAX_RETRIES) {
        lastError = apiErr;
        continue;
      }
      throw apiErr;
    }

    if (resp.status === 204) {
      return [{} as T, resp.headers];
    }

    const data = await resp.json() as T;
    return [data, resp.headers];
  }

  throw lastError ?? new ApiError({
    platform: "github",
    status: 0,
    code: "network",
    message: "Request failed after all retries.",
  });
}

/**
 * Fetches all pages of a paginated GitHub list endpoint by following
 * `Link: <url>; rel="next"` headers.
 *
 * Stops when there is no next-page link or `maxPages` pages have been
 * fetched (clamped to {@link MAX_PAGES_LIMIT}).
 *
 * @typeParam T - Element type of the array returned on each page.
 * @param token - GitHub personal access token.
 * @param initialUrl - URL of the first page (may include query parameters).
 * @param maxPages - Maximum pages to fetch; clamped to `MAX_PAGES_LIMIT`.
 * @param opts - Optional request options forwarded to every page request.
 * @returns Flat array of all items collected across all fetched pages.
 * @throws `ApiError` on any page request failure.
 */
async function paginate<T>(
  token: string,
  initialUrl: string,
  maxPages = DEFAULT_MAX_PAGES,
  opts?: RequestOptions,
): Promise<T[]> {
  const limit = Math.min(maxPages, MAX_PAGES_LIMIT);
  const results: T[] = [];
  let nextUrl: string | undefined = initialUrl;
  let page = 0;

  while (nextUrl !== undefined && page < limit) {
    const pageResult: [T[], Headers] = await request<T[]>(token, nextUrl, opts);
    results.push(...pageResult[0]);
    page++;
    const linkHeader: string | null = pageResult[1].get("Link");
    nextUrl = linkHeader !== null ? parseLinkNext(linkHeader) : undefined;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalises a raw GitHub repository object to a unified `Repo`.
 *
 * `openPRCount` is not returned by GitHub's repository endpoints; callers
 * that know the value may supply it, otherwise it defaults to `0`.
 *
 * @param raw - Raw JSON object from the GitHub repositories API.
 * @param openPRCount - Known open-PR count; defaults to `0`.
 * @returns Normalised `Repo` value.
 */
function normalizeRepo(raw: RawGHRepo, openPRCount = 0): Repo {
  const repo: Repo = {
    id: String(raw.id),
    platform: "github",
    fullName: raw.full_name,
    url: raw.html_url,
    defaultBranch: raw.default_branch,
    isPrivate: raw.private,
    starCount: raw.stargazers_count,
    openIssueCount: raw.open_issues_count,
    openPRCount,
  };
  if (raw.language !== null) repo.language = raw.language;
  if (raw.description !== null) repo.description = raw.description;
  return repo;
}

/**
 * Derives a normalised `CIStatus` from an array of GitHub check-run objects.
 *
 * Precedence (highest wins): `failed` > `running` > `pending` >
 * `cancelled` > `success`. Returns `undefined` when the array is empty.
 *
 * @param runs - Check-run objects from the GitHub check-runs API.
 * @returns Computed `CIStatus`, or `undefined` if no runs are present.
 */
function mapCheckRunsToCIStatus(runs: RawGHCheckRun[]): CIStatus | undefined {
  if (runs.length === 0) return undefined;

  let hasRunning = false;
  let hasPending = false;
  let hasFailed = false;
  let hasCancelled = false;

  for (const run of runs) {
    if (run.status === "in_progress") {
      hasRunning = true;
      continue;
    }
    if (run.status === "queued" || run.status === "waiting") {
      hasPending = true;
      continue;
    }
    const c = run.conclusion;
    if (c === "failure" || c === "timed_out" || c === "startup_failure") {
      hasFailed = true;
      continue;
    }
    if (c === "cancelled") {
      hasCancelled = true;
    }
  }

  if (hasFailed) return "failed";
  if (hasRunning) return "running";
  if (hasPending) return "pending";
  if (hasCancelled) return "cancelled";
  return "success";
}

/**
 * Computes an aggregated `ReviewDecision` from a PR's review history.
 *
 * Tracks the most-recent non-pending review state per reviewer (GitHub
 * returns reviews oldest-first). Rules:
 * - Any current `CHANGES_REQUESTED` → `"changes_requested"`
 * - At least one `APPROVED` with no `CHANGES_REQUESTED` → `"approved"`
 * - Non-empty but inconclusive → `"review_required"`
 *
 * @param reviews - Raw review objects ordered oldest-first from the GitHub API.
 * @returns Computed `ReviewDecision`, or `undefined` if no reviews exist.
 */
function computeReviewDecision(reviews: RawGHReview[]): ReviewDecision | undefined {
  if (reviews.length === 0) return undefined;

  const latestByReviewer = new Map<string, string>();
  for (const r of reviews) {
    if (r.state === "PENDING") continue;
    const login = r.user?.login ?? "unknown";
    latestByReviewer.set(login, r.state);
  }

  if (latestByReviewer.size === 0) return undefined;

  let hasApproval = false;
  let hasChangesRequested = false;
  for (const state of latestByReviewer.values()) {
    if (state === "APPROVED") hasApproval = true;
    if (state === "CHANGES_REQUESTED") hasChangesRequested = true;
  }

  if (hasChangesRequested) return "changes_requested";
  if (hasApproval) return "approved";
  return "review_required";
}

/**
 * Maps a GitHub workflow-run `status` + `conclusion` pair to a normalised
 * `PipelineStatus`.
 *
 * @param status - GitHub run status string.
 * @param conclusion - GitHub run conclusion string, or `null` if still running.
 * @returns Normalised pipeline status.
 */
function mapWorkflowRunStatus(
  status: string,
  conclusion: string | null,
): Pipeline["status"] {
  if (status === "in_progress") return "running";
  if (status === "queued" || status === "waiting") return "pending";
  if (status === "completed") {
    if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") {
      return "success";
    }
    if (conclusion === "cancelled") return "cancelled";
    return "failed";
  }
  return "pending";
}

/**
 * Normalises a raw GitHub pull-request object to a unified `PullRequest`.
 *
 * `additions`, `deletions`, and `changedFiles` default to `0` when called
 * from a list endpoint response (which omits these fields). Use `getPR` to
 * obtain accurate values for a single PR.
 *
 * Exported for unit testing of type-normalisation logic. Production callers
 * should prefer the high-level `listPRs` / `getPR` functions.
 *
 * @param raw - Raw JSON object from the GitHub pulls API.
 * @param repoFullName - `"owner/repo"` path of the containing repository.
 * @param reviewDecision - Pre-computed review decision (optional).
 * @param ciStatus - Pre-fetched CI status for the PR head (optional).
 * @returns Normalised `PullRequest` value.
 */
export function normalizePR(
  raw: RawGHPR,
  repoFullName: string,
  reviewDecision?: ReviewDecision,
  ciStatus?: CIStatus,
): PullRequest {
  const state: PRState = raw.merged_at !== null
    ? "merged"
    : raw.state === "open"
    ? "open"
    : "closed";

  const pr: PullRequest = {
    id: String(raw.id),
    platform: "github",
    repo: repoFullName,
    number: raw.number,
    title: raw.title,
    state,
    isDraft: raw.draft,
    author: raw.user?.login ?? "unknown",
    assignees: raw.assignees.map((u) => u.login),
    reviewers: raw.requested_reviewers.map((u) => u.login),
    labels: raw.labels.map((l) => l.name),
    sourceBranch: raw.head.ref,
    targetBranch: raw.base.ref,
    url: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    commentCount: raw.comments + raw.review_comments,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changed_files ?? 0,
  };

  if (raw.body !== null) pr.body = raw.body;
  if (raw.mergeable_state !== undefined) pr.mergeableState = raw.mergeable_state;
  if (reviewDecision !== undefined) pr.reviewDecision = reviewDecision;
  if (ciStatus !== undefined) pr.ciStatus = ciStatus;
  return pr;
}

/**
 * Normalises a raw GitHub issue object to a unified `Issue`.
 *
 * Callers must ensure the raw object does not have a `pull_request` key
 * (which would indicate a PR masquerading as an issue on this endpoint).
 *
 * Exported for unit testing of type-normalisation logic. Production callers
 * should prefer the high-level `listIssues` function, which performs the
 * `pull_request` key filter automatically before calling this helper.
 *
 * @param raw - Raw JSON object from the GitHub issues API, without `pull_request`.
 * @param repoFullName - `"owner/repo"` path of the containing repository.
 * @returns Normalised `Issue` value.
 */
export function normalizeIssue(raw: RawGHIssue, repoFullName: string): Issue {
  const issue: Issue = {
    id: String(raw.id),
    platform: "github",
    repo: repoFullName,
    number: raw.number,
    title: raw.title,
    state: raw.state === "open" ? "open" : "closed",
    author: raw.user?.login ?? "unknown",
    assignees: raw.assignees.map((u) => u.login),
    labels: raw.labels.map((l) => l.name),
    url: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    commentCount: raw.comments,
  };
  if (raw.body !== null) issue.body = raw.body;
  return issue;
}

/**
 * Normalises a raw GitHub branch object to a unified `Branch`.
 *
 * @param raw - Raw JSON object from the GitHub branches API.
 * @returns Normalised `Branch` value.
 */
function normalizeBranch(raw: RawGHBranch): Branch {
  return {
    name: raw.name,
    isProtected: raw.protected,
    lastCommitSha: raw.commit.sha,
  };
}

/**
 * Normalises a raw GitHub workflow-run object to a unified `Pipeline`.
 *
 * Duration is computed from `run_started_at` and `updated_at` when the run
 * has completed. The `name` field falls back to `"Workflow Run"` when null.
 *
 * Exported for unit testing of type-normalisation logic. Production callers
 * should prefer the high-level `listWorkflowRuns` function.
 *
 * @param raw - Raw JSON object from the GitHub workflow-runs API.
 * @param repoFullName - `"owner/repo"` path of the containing repository.
 * @returns Normalised `Pipeline` value.
 */
export function normalizePipeline(raw: RawGHWorkflowRun, repoFullName: string): Pipeline {
  const status = mapWorkflowRunStatus(raw.status, raw.conclusion);

  const pipeline: Pipeline = {
    id: String(raw.id),
    platform: "github",
    repo: repoFullName,
    name: raw.name ?? "Workflow Run",
    status,
    branch: raw.head_branch ?? "",
    commitSha: raw.head_sha,
    url: raw.html_url,
  };

  if (raw.run_started_at !== null) pipeline.startedAt = raw.run_started_at;
  if (raw.status === "completed") pipeline.finishedAt = raw.updated_at;

  if (raw.run_started_at !== null && raw.status === "completed") {
    const startMs = new Date(raw.run_started_at).getTime();
    const endMs = new Date(raw.updated_at).getTime();
    if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
      pipeline.durationSeconds = Math.round((endMs - startMs) / 1_000);
    }
  }

  return pipeline;
}

/**
 * Normalises a raw GitHub review object to a unified `Review`.
 *
 * GitHub review states (`APPROVED`, `CHANGES_REQUESTED`, `DISMISSED`,
 * `COMMENTED`) are mapped to lowercase `ReviewState` values.
 *
 * @param raw - Raw JSON object from the GitHub pull-request reviews API.
 * @param repoFullName - `"owner/repo"` path of the containing repository.
 * @param prNumber - Sequential pull-request number this review belongs to.
 * @returns Normalised `Review` value.
 */
function normalizeReview(
  raw: RawGHReview,
  repoFullName: string,
  prNumber: number,
): Review {
  let state: ReviewState;
  switch (raw.state) {
    case "APPROVED":
      state = "approved";
      break;
    case "CHANGES_REQUESTED":
      state = "changes_requested";
      break;
    case "DISMISSED":
      state = "dismissed";
      break;
    default:
      state = "comment";
  }

  const review: Review = {
    id: String(raw.id),
    platform: "github",
    prNumber,
    repo: repoFullName,
    reviewer: raw.user?.login ?? "unknown",
    state,
    submittedAt: raw.submitted_at,
    url: raw.html_url,
  };
  if (raw.body) review.body = raw.body;
  return review;
}

/**
 * Normalises a raw GitHub Dependabot alert to a unified `SecurityAlert`.
 *
 * Vulnerability details are taken from the first entry in the advisory's
 * `vulnerabilities` array. Severity strings are lower-cased and mapped via
 * {@link mapSeverity}; unknown values fall back to `"info"`.
 *
 * @param raw - Raw JSON object from the GitHub Dependabot alerts API.
 * @param repoFullName - `"owner/repo"` path of the containing repository.
 * @returns Normalised `SecurityAlert` value.
 */
function normalizeSecurityAlert(
  raw: RawGHDependabotAlert,
  repoFullName: string,
): SecurityAlert {
  const firstVuln = raw.security_advisory.vulnerabilities[0];
  const vulnerableRange = firstVuln?.vulnerable_version_range ?? "unknown";
  const fixedVersion = firstVuln?.first_patched_version?.identifier;

  const alert: SecurityAlert = {
    id: String(raw.number),
    platform: "github",
    repo: repoFullName,
    title: raw.security_advisory.summary,
    severity: mapSeverity(raw.security_advisory.severity),
    packageName: raw.dependency.package.name,
    vulnerableRange,
    url: raw.html_url,
    createdAt: raw.created_at,
  };
  if (fixedVersion !== undefined) alert.fixedVersion = fixedVersion;
  return alert;
}

/**
 * Normalises a single GitHub code-search result item to a unified `CodeResult`.
 *
 * Text-match fragments are extracted from the `text_matches` array, which is
 * only populated when the request includes the
 * `Accept: application/vnd.github.text-match+json` header.
 *
 * @param raw - Raw code-search result item from the GitHub search API.
 * @returns Normalised `CodeResult` value.
 */
function normalizeCodeResult(raw: RawGHCodeSearchItem): CodeResult {
  const firstMatch = raw.text_matches?.[0];
  return {
    path: raw.path,
    repo: raw.repository.full_name,
    platform: "github",
    url: raw.html_url,
    fragment: firstMatch?.fragment ?? "",
  };
}

// ---------------------------------------------------------------------------
// Exported API functions
// ---------------------------------------------------------------------------

/**
 * Lists repositories accessible to the authenticated user.
 *
 * Uses `GET /user/repos` with `affiliation=owner,collaborator,organization_member`
 * sorted by last-updated date. Follows pagination up to `maxPages`.
 *
 * @param token - GitHub personal access token.
 * @param maxPages - Maximum pages to fetch (default {@link DEFAULT_MAX_PAGES}).
 * @returns Array of normalised `Repo` objects.
 * @throws `ApiError` on API or network failure.
 */
export async function listRepos(
  token: string,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<Repo[]> {
  const url =
    `${BASE_URL}/user/repos` +
    `?affiliation=owner%2Ccollaborator%2Corganization_member&sort=updated&per_page=100`;
  const raws = await paginate<RawGHRepo>(token, url, maxPages);
  return raws.map((r) => normalizeRepo(r));
}

/**
 * Fetches a single repository by owner and name.
 *
 * Uses `GET /repos/{owner}/{repo}`.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login (user or organisation).
 * @param repo - Repository name.
 * @returns Normalised `Repo` object.
 * @throws `ApiError` on API or network failure (404 if not found).
 */
export async function getRepo(
  token: string,
  owner: string,
  repo: string,
): Promise<Repo> {
  const url = `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const [raw] = await request<RawGHRepo>(token, url);
  return normalizeRepo(raw);
}

/**
 * Lists pull requests for a repository.
 *
 * Uses `GET /repos/{owner}/{repo}/pulls`. Follows pagination up to `maxPages`.
 *
 * Note: `additions`, `deletions`, `changedFiles`, `reviewDecision`, and
 * `ciStatus` are not available from the list endpoint and default to `0` /
 * `undefined`. Call `getPR` to retrieve a single PR with all fields populated.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param options.state - Filter by PR state (`"open"` default, `"closed"`, or `"all"`).
 * @param options.maxPages - Maximum pages to fetch (default {@link DEFAULT_MAX_PAGES}).
 * @returns Array of normalised `PullRequest` objects.
 * @throws `ApiError` on API or network failure.
 */
export async function listPRs(
  token: string,
  owner: string,
  repo: string,
  options?: { state?: "open" | "closed" | "all"; maxPages?: number },
): Promise<PullRequest[]> {
  const state = options?.state ?? "open";
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;
  const repoFullName = `${owner}/${repo}`;
  const url =
    `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls` +
    `?state=${state}&sort=updated&direction=desc&per_page=100`;
  const raws = await paginate<RawGHPR>(token, url, maxPages);
  return raws.map((r) => normalizePR(r, repoFullName));
}

/**
 * Fetches a single pull request with complete details including diff statistics,
 * aggregated review decision, and CI status from check runs.
 *
 * Makes three network requests in sequence then parallel:
 * 1. `GET /repos/{owner}/{repo}/pulls/{pull_number}` — PR details + diff stats.
 * 2. (Parallel) `GET …/pulls/{pull_number}/reviews` — to compute `reviewDecision`.
 * 3. (Parallel) `GET …/commits/{sha}/check-runs` — to compute `ciStatus`.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param prNumber - Pull request number.
 * @returns Fully-populated normalised `PullRequest`.
 * @throws `ApiError` on API or network failure.
 */
export async function getPR(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequest> {
  const repoFullName = `${owner}/${repo}`;
  const base = `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  // Step 1: fetch the PR to obtain the head SHA for check-runs.
  const [prRaw] = await request<RawGHPR>(token, `${base}/pulls/${prNumber}`);

  // Step 2: fetch reviews and check-runs in parallel.
  const reviewsReq = request<RawGHReview[]>(
    token,
    `${base}/pulls/${prNumber}/reviews?per_page=100`,
  );
  const checkRunsReq = request<RawGHCheckRunsResponse>(
    token,
    `${base}/commits/${encodeURIComponent(prRaw.head.sha)}/check-runs?per_page=100`,
  );

  const [[reviewsRaw], [checkRunsRaw]] = await Promise.all([reviewsReq, checkRunsReq]);

  const reviewDecision = computeReviewDecision(reviewsRaw);
  const ciStatus = mapCheckRunsToCIStatus(checkRunsRaw.check_runs);

  return normalizePR(prRaw, repoFullName, reviewDecision, ciStatus);
}

/**
 * Creates a new pull request.
 *
 * Uses `POST /repos/{owner}/{repo}/pulls`.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param params.title - PR title.
 * @param params.head - Branch containing the changes (format: `"branch"` or `"fork:branch"`).
 * @param params.base - Branch to merge into.
 * @param params.body - Optional PR description.
 * @param params.draft - Whether to create as a draft PR.
 * @returns Normalised `PullRequest` for the newly created PR.
 * @throws `ApiError` on API or network failure.
 */
export async function createPR(
  token: string,
  owner: string,
  repo: string,
  params: { title: string; head: string; base: string; body?: string; draft?: boolean },
): Promise<PullRequest> {
  const repoFullName = `${owner}/${repo}`;
  const requestBody: Record<string, unknown> = {
    title: params.title,
    head: params.head,
    base: params.base,
  };
  if (params.body !== undefined) requestBody["body"] = params.body;
  if (params.draft !== undefined) requestBody["draft"] = params.draft;

  const url = `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
  const [raw] = await request<RawGHPR>(token, url, {
    method: "POST",
    body: JSON.stringify(requestBody),
  });
  return normalizePR(raw, repoFullName);
}

/**
 * Merges a pull request.
 *
 * Uses `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param prNumber - Pull request number to merge.
 * @param options.mergeMethod - Merge strategy: `"merge"` (default), `"squash"`, or `"rebase"`.
 * @throws `ApiError` on API or network failure (405 if not mergeable).
 */
export async function mergePR(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  options?: { mergeMethod?: "merge" | "squash" | "rebase" },
): Promise<void> {
  const url =
    `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/pulls/${prNumber}/merge`;
  const requestBody: Record<string, unknown> = {
    merge_method: options?.mergeMethod ?? "merge",
  };
  await request<RawGHMergeResponse>(token, url, {
    method: "PUT",
    body: JSON.stringify(requestBody),
  });
}

/**
 * Lists code reviews for a pull request.
 *
 * Uses `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`.
 * Follows pagination up to `maxPages`.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param prNumber - Pull request number.
 * @param maxPages - Maximum pages to fetch (default {@link DEFAULT_MAX_PAGES}).
 * @returns Array of normalised `Review` objects.
 * @throws `ApiError` on API or network failure.
 */
export async function listReviews(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<Review[]> {
  const repoFullName = `${owner}/${repo}`;
  const url =
    `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/pulls/${prNumber}/reviews?per_page=100`;
  const raws = await paginate<RawGHReview>(token, url, maxPages);
  return raws.map((r) => normalizeReview(r, repoFullName, prNumber));
}

/**
 * Submits a review on a pull request.
 *
 * Uses `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`.
 * Maps the friendly `event` values to GitHub's UPPER_CASE equivalents.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param prNumber - Pull request number.
 * @param params.event - Review action: `"approve"`, `"request_changes"`, or `"comment"`.
 * @param params.body - Review comment body (required when `event` is `"request_changes"`).
 * @returns Normalised `Review` for the submitted review.
 * @throws `ApiError` on API or network failure.
 */
export async function createReview(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  params: { event: "approve" | "request_changes" | "comment"; body?: string },
): Promise<Review> {
  const repoFullName = `${owner}/${repo}`;
  const eventMap: Record<string, string> = {
    approve: "APPROVE",
    request_changes: "REQUEST_CHANGES",
    comment: "COMMENT",
  };
  const requestBody: Record<string, unknown> = {
    event: eventMap[params.event] ?? "COMMENT",
  };
  if (params.body !== undefined) requestBody["body"] = params.body;

  const url =
    `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/pulls/${prNumber}/reviews`;
  const [raw] = await request<RawGHReview>(token, url, {
    method: "POST",
    body: JSON.stringify(requestBody),
  });
  return normalizeReview(raw, repoFullName, prNumber);
}

/**
 * Lists issues for a repository, excluding pull requests.
 *
 * Uses `GET /repos/{owner}/{repo}/issues`. GitHub's issues endpoint returns
 * both issues and pull requests; items with a `pull_request` key are filtered
 * out before normalisation.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param options.state - Filter by issue state (`"open"` default, `"closed"`, or `"all"`).
 * @param options.filter - Filter scope: `"assigned"` (assigned to viewer),
 *   `"created"` (created by viewer), or `"mentioned"`.
 * @param options.since - ISO 8601 timestamp; only issues updated at or after this time.
 * @param options.maxPages - Maximum pages to fetch (default {@link DEFAULT_MAX_PAGES}).
 * @returns Array of normalised `Issue` objects (pull requests excluded).
 * @throws `ApiError` on API or network failure.
 */
export async function listIssues(
  token: string,
  owner: string,
  repo: string,
  options?: {
    state?: "open" | "closed" | "all";
    filter?: "assigned" | "created" | "mentioned";
    since?: string;
    maxPages?: number;
  },
): Promise<Issue[]> {
  const repoFullName = `${owner}/${repo}`;
  const state = options?.state ?? "open";
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;

  const params = new URLSearchParams({ state, per_page: "100" });
  if (options?.filter !== undefined) params.set("filter", options.filter);
  if (options?.since !== undefined) params.set("since", options.since);

  const url =
    `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues` +
    `?${params.toString()}`;
  const raws = await paginate<RawGHIssue>(token, url, maxPages);

  // Filter out pull requests — GitHub returns them from the issues endpoint.
  return raws
    .filter((r) => r.pull_request === undefined)
    .map((r) => normalizeIssue(r, repoFullName));
}

/**
 * Creates a new issue.
 *
 * Uses `POST /repos/{owner}/{repo}/issues`.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param params.title - Issue title.
 * @param params.body - Optional issue description.
 * @param params.labels - Optional array of label names to apply.
 * @param params.assignees - Optional array of login names to assign.
 * @returns Normalised `Issue` for the newly created issue.
 * @throws `ApiError` on API or network failure.
 */
export async function createIssue(
  token: string,
  owner: string,
  repo: string,
  params: { title: string; body?: string; labels?: string[]; assignees?: string[] },
): Promise<Issue> {
  const repoFullName = `${owner}/${repo}`;
  const requestBody: Record<string, unknown> = { title: params.title };
  if (params.body !== undefined) requestBody["body"] = params.body;
  if (params.labels !== undefined) requestBody["labels"] = params.labels;
  if (params.assignees !== undefined) requestBody["assignees"] = params.assignees;

  const url =
    `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
  const [raw] = await request<RawGHIssue>(token, url, {
    method: "POST",
    body: JSON.stringify(requestBody),
  });
  return normalizeIssue(raw, repoFullName);
}

/**
 * Updates an existing issue.
 *
 * Uses `PATCH /repos/{owner}/{repo}/issues/{issue_number}`. Only supplied
 * fields are sent in the request body.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param issueNumber - Issue number to update.
 * @param params - Fields to update (all optional).
 * @returns Normalised `Issue` reflecting the updated state.
 * @throws `ApiError` on API or network failure.
 */
export async function updateIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  params: {
    title?: string;
    body?: string;
    state?: "open" | "closed";
    labels?: string[];
    assignees?: string[];
  },
): Promise<Issue> {
  const repoFullName = `${owner}/${repo}`;
  const requestBody: Record<string, unknown> = {};
  if (params.title !== undefined) requestBody["title"] = params.title;
  if (params.body !== undefined) requestBody["body"] = params.body;
  if (params.state !== undefined) requestBody["state"] = params.state;
  if (params.labels !== undefined) requestBody["labels"] = params.labels;
  if (params.assignees !== undefined) requestBody["assignees"] = params.assignees;

  const url =
    `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/issues/${issueNumber}`;
  const [raw] = await request<RawGHIssue>(token, url, {
    method: "PATCH",
    body: JSON.stringify(requestBody),
  });
  return normalizeIssue(raw, repoFullName);
}

/**
 * Lists branches for a repository.
 *
 * Uses `GET /repos/{owner}/{repo}/branches`. Follows pagination up to `maxPages`.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param maxPages - Maximum pages to fetch (default {@link DEFAULT_MAX_PAGES}).
 * @returns Array of normalised `Branch` objects.
 * @throws `ApiError` on API or network failure.
 */
export async function listBranches(
  token: string,
  owner: string,
  repo: string,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<Branch[]> {
  const url =
    `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/branches?per_page=100`;
  const raws = await paginate<RawGHBranch>(token, url, maxPages);
  return raws.map(normalizeBranch);
}

/**
 * Lists GitHub Actions workflow runs for a repository.
 *
 * Uses `GET /repos/{owner}/{repo}/actions/runs`. Supports filtering by branch
 * and status. Follows pagination up to `maxPages`.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param options.branch - Filter runs to this branch name.
 * @param options.status - Filter by run status (e.g. `"failure"`, `"success"`).
 * @param options.maxPages - Maximum pages to fetch (default {@link DEFAULT_MAX_PAGES}).
 * @returns Array of normalised `Pipeline` objects.
 * @throws `ApiError` on API or network failure.
 */
export async function listWorkflowRuns(
  token: string,
  owner: string,
  repo: string,
  options?: { branch?: string; status?: string; maxPages?: number },
): Promise<Pipeline[]> {
  const repoFullName = `${owner}/${repo}`;
  const params = new URLSearchParams({ per_page: "100" });
  if (options?.branch !== undefined) params.set("branch", options.branch);
  if (options?.status !== undefined) params.set("status", options.status);

  const firstPageUrl =
    `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/actions/runs?${params.toString()}`;

  // The workflow-runs endpoint wraps the array in { workflow_runs: [...] }.
  // We cannot use paginate<T> directly for a wrapped response, so we follow
  // Link headers manually.
  const maxPages = Math.min(options?.maxPages ?? DEFAULT_MAX_PAGES, MAX_PAGES_LIMIT);
  const allRuns: RawGHWorkflowRun[] = [];
  let nextUrl: string | undefined = firstPageUrl;
  let page = 0;

  while (nextUrl !== undefined && page < maxPages) {
    const runPageResult: [RawGHWorkflowRunsResponse, Headers] = await request<
      RawGHWorkflowRunsResponse
    >(token, nextUrl);
    allRuns.push(...runPageResult[0].workflow_runs);
    page++;
    const runLinkHeader: string | null = runPageResult[1].get("Link");
    nextUrl = runLinkHeader !== null ? parseLinkNext(runLinkHeader) : undefined;
  }

  return allRuns.map((r) => normalizePipeline(r, repoFullName));
}

/**
 * Triggers a GitHub Actions workflow run via the `workflow_dispatch` event.
 *
 * Uses `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`.
 * Returns `void` on success (GitHub responds with 204 No Content).
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param workflowId - Workflow file name (e.g. `"ci.yml"`) or numeric workflow ID.
 * @param ref - Branch or tag ref to run the workflow on (e.g. `"main"`).
 * @param inputs - Optional key/value inputs defined in the workflow's `on.workflow_dispatch.inputs`.
 * @throws `ApiError` on API or network failure (404 if workflow not found, 422 if ref invalid).
 */
export async function triggerWorkflow(
  token: string,
  owner: string,
  repo: string,
  workflowId: string,
  ref: string,
  inputs?: Record<string, string>,
): Promise<void> {
  const requestBody: Record<string, unknown> = { ref };
  if (inputs !== undefined) requestBody["inputs"] = inputs;

  const url =
    `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`;
  await request<Record<never, never>>(token, url, {
    method: "POST",
    body: JSON.stringify(requestBody),
  });
}

/**
 * Lists Dependabot security alerts for a repository.
 *
 * Uses `GET /repos/{owner}/{repo}/dependabot/alerts`. Requires the
 * `security_events` scope (classic token) or Dependabot alerts read
 * permission (fine-grained token). Follows pagination up to `maxPages`.
 *
 * @param token - GitHub personal access token.
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param options.state - Filter by alert state (`"open"` default, `"dismissed"`,
 *   `"auto_dismissed"`, or `"fixed"`).
 * @param options.maxPages - Maximum pages to fetch (default {@link DEFAULT_MAX_PAGES}).
 * @returns Array of normalised `SecurityAlert` objects.
 * @throws `ApiError` on API or network failure.
 */
export async function listSecurityAlerts(
  token: string,
  owner: string,
  repo: string,
  options?: {
    state?: "open" | "dismissed" | "auto_dismissed" | "fixed";
    maxPages?: number;
  },
): Promise<SecurityAlert[]> {
  const repoFullName = `${owner}/${repo}`;
  const state = options?.state ?? "open";
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;
  const url =
    `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/dependabot/alerts?state=${state}&per_page=100`;
  const raws = await paginate<RawGHDependabotAlert>(token, url, maxPages);
  return raws.map((r) => normalizeSecurityAlert(r, repoFullName));
}

/**
 * Searches code across GitHub using the code search API.
 *
 * Uses `GET /search/code`. When `options.repo` is supplied the query is
 * automatically scoped with `repo:owner/repo`. Requests the
 * `text-match` media type so that matched code fragments are included.
 *
 * Note: GitHub's code search API is subject to secondary rate limits and
 * requires the repository to be indexed. Results may be incomplete for very
 * large codebases.
 *
 * @param token - GitHub personal access token.
 * @param query - Search query string (GitHub search syntax supported).
 * @param options.repo - Optional `"owner/repo"` to scope the search.
 * @param options.maxPages - Maximum pages to fetch (default {@link DEFAULT_MAX_PAGES}).
 * @returns Array of normalised `CodeResult` objects.
 * @throws `ApiError` on API or network failure.
 */
export async function searchCode(
  token: string,
  query: string,
  options?: { repo?: string; maxPages?: number },
): Promise<CodeResult[]> {
  let q = query;
  if (options?.repo !== undefined) q += ` repo:${options.repo}`;

  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;
  const limit = Math.min(maxPages, MAX_PAGES_LIMIT);

  // The search API wraps results in { items: [...] } and uses standard Link
  // headers for pagination.
  const allItems: RawGHCodeSearchItem[] = [];
  let nextUrl: string | undefined =
    `${BASE_URL}/search/code?q=${encodeURIComponent(q)}&per_page=100`;
  let page = 0;

  while (nextUrl !== undefined && page < limit) {
    const searchPageResult: [RawGHCodeSearchResponse, Headers] = await request<
      RawGHCodeSearchResponse
    >(token, nextUrl, {
      headers: { "Accept": "application/vnd.github.text-match+json" },
    });
    allItems.push(...searchPageResult[0].items);
    page++;
    const searchLinkHeader: string | null = searchPageResult[1].get("Link");
    nextUrl = searchLinkHeader !== null ? parseLinkNext(searchLinkHeader) : undefined;
  }

  return allItems.map(normalizeCodeResult);
}
