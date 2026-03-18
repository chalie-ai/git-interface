/**
 * @module gitlab/client
 *
 * GitLab REST API v4 client with typed error handling, exponential-backoff
 * retry logic, and X-Next-Page header pagination.
 *
 * All public functions accept a GitLab personal access token as their first
 * argument and return unified types from `~/shared/types.ts`. Every non-2xx
 * response is mapped to a typed {@link ApiError} before being thrown.
 *
 * ## Project identifiers
 * All functions accept `projectId` as a URL-encoded namespace path
 * (e.g. `"owner%2Frepo"`). Use {@link encodeProjectPath} to convert a
 * human-readable `"owner/repo"` string to the correct format before passing
 * it to any function in this module.
 *
 * ## Retry policy
 * Transient errors (`server_error`, `network`) are retried up to 2 times with
 * exponential back-off: 1 s then 3 s. 4xx errors are never retried.
 *
 * ## Pagination
 * List functions follow GitLab's `X-Next-Page` response header.
 * The `maxPages` parameter (default 3, hard cap 10) controls how many pages
 * are fetched before stopping. Pass a higher value for projects with many
 * resources.
 *
 * ## Rate limiting
 * Every response is inspected for `RateLimit-Remaining` and `RateLimit-Reset`
 * headers. When `RateLimit-Remaining` drops below {@link RATE_LIMIT_WARN_THRESHOLD},
 * a module-level flag is set. Query {@link isRateLimitLow} to check this flag
 * before issuing non-critical requests. 429 responses always honour the
 * `Retry-After` header value.
 */

import {
  ApiError,
  type ApiErrorPayload,
  type Branch,
  type CodeResult,
  type Comment,
  type Issue,
  type IssueState,
  type Pipeline,
  type PipelineStatus,
  type PRState,
  type PullRequest,
  type Repo,
  type Review,
  type ReviewState,
} from "~/shared/mod.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** GitLab REST API v4 base URL. Override via `GITLAB_BASE_URL` env var for self-hosted instances. */
const BASE_URL = (typeof Deno !== "undefined" && Deno.env.get("GITLAB_BASE_URL")) ||
  "https://gitlab.com/api/v4";

/** Hard upper limit on pages fetched in a single paginated call. */
const MAX_PAGES_LIMIT = 10;

/** Default number of pages fetched when callers omit `maxPages`. */
const DEFAULT_MAX_PAGES = 3;

/** Maximum number of retry attempts for transient errors (excludes initial attempt). */
const MAX_RETRIES = 2;

/**
 * When `RateLimit-Remaining` drops at or below this threshold the module sets
 * the low-rate-limit flag readable via {@link isRateLimitLow}.
 */
const RATE_LIMIT_WARN_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Module-level rate-limit state
// ---------------------------------------------------------------------------

/** Most-recently observed `RateLimit-Remaining` value (undefined = not yet seen). */
let _rateLimitRemaining: number | undefined;

/** Unix timestamp (seconds) at which the rate limit resets, or undefined. */
let _rateLimitReset: number | undefined;

/**
 * Returns `true` when the most recently observed `RateLimit-Remaining` header
 * value is at or below {@link RATE_LIMIT_WARN_THRESHOLD}.
 *
 * Callers performing non-critical work should check this flag and defer
 * requests when it is `true`.
 *
 * @returns Whether the GitLab API rate limit is running low.
 */
export function isRateLimitLow(): boolean {
  return _rateLimitRemaining !== undefined &&
    _rateLimitRemaining <= RATE_LIMIT_WARN_THRESHOLD;
}

/**
 * Returns the most recently observed rate-limit state, if any.
 *
 * @returns Object with `remaining` and `resetAt` (Unix seconds) fields,
 *   or `undefined` if no rate-limit headers have been received yet.
 */
export function getRateLimitState():
  | { remaining: number; resetAt: number | undefined }
  | undefined {
  if (_rateLimitRemaining === undefined) return undefined;
  return { remaining: _rateLimitRemaining, resetAt: _rateLimitReset };
}

// ---------------------------------------------------------------------------
// Internal raw GitLab API response shapes
// (private — never exported; always narrowed before use)
// ---------------------------------------------------------------------------

interface RawGLUser {
  username: string;
}

interface RawGLLabel {
  name: string;
}

interface RawGLProject {
  id: number;
  path_with_namespace: string;
  web_url: string;
  default_branch: string | null;
  visibility: string; // "private" | "internal" | "public"
  predominant_language?: string | null;
  description: string | null;
  star_count: number;
  open_issues_count: number;
  /** Not returned by list endpoint; only on single-project response. */
  statistics?: {
    commit_count: number;
    storage_size: number;
    repository_size: number;
    wiki_size: number;
    lfs_objects_size: number;
    job_artifacts_size: number;
    packages_size: number;
    snippets_size: number;
    uploads_size: number;
  };
}

interface RawGLMR {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string; // "opened" | "closed" | "locked" | "merged"
  /** Legacy draft flag (deprecated but may still appear in older instances). */
  work_in_progress: boolean;
  /** Modern draft flag. */
  draft: boolean;
  author: RawGLUser | null;
  assignees: RawGLUser[];
  reviewers: RawGLUser[];
  labels: string[];
  source_branch: string;
  target_branch: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  user_notes_count: number;
  /** Number of changed files — returned as string or number depending on API version. */
  changes_count: string | number | null;
  /** Only present on single MR endpoint. */
  additions?: number | null;
  /** Only present on single MR endpoint. */
  deletions?: number | null;
  diff_refs: {
    head_sha: string;
  } | null;
  head_pipeline?: RawGLPipelineRef | null;
  merge_commit_sha: string | null;
  sha: string;
}

interface RawGLPipelineRef {
  id: number;
  status: string;
}

interface RawGLApprovals {
  id: number;
  iid: number;
  project_id: number;
  approved: boolean;
  approved_by: Array<{ user: RawGLUser }>;
  approval_rules_left: Array<{ name: string }>;
  created_at: string;
  web_url: string;
}

interface RawGLNote {
  id: number;
  body: string;
  author: RawGLUser;
  created_at: string;
  updated_at: string;
  noteable_type: string;
  noteable_iid: number;
}

interface RawGLIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string; // "opened" | "closed"
  author: RawGLUser | null;
  assignees: RawGLUser[];
  labels: string[];
  web_url: string;
  created_at: string;
  updated_at: string;
  user_notes_count: number;
}

interface RawGLBranch {
  name: string;
  protected: boolean;
  commit: { id: string };
}

interface RawGLPipeline {
  id: number;
  /** "created" | "waiting_for_resource" | "preparing" | "pending" | "running" | "success" | "failed" | "canceled" | "skipping" | "blocked" | "scheduled" */
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration: number | null;
  /** Pipeline name, only available on detailed pipeline responses. */
  name?: string | null;
}

interface RawGLCodeBlob {
  basename: string;
  data: string;
  path: string;
  filename: string;
  id: string | null;
  ref: string;
  startline: number;
  project_id: number;
}

interface RawGLTriggerPipelineResponse {
  id: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration: number | null;
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
 * Converts a human-readable `"owner/repo"` namespace path to the
 * URL-encoded form required by the GitLab API (`"owner%2Frepo"`).
 *
 * @param fullName - Repository full name in `"owner/repo"` format.
 * @returns URL-encoded namespace path suitable for GitLab API path segments.
 *
 * @example
 * ```ts
 * encodeProjectPath("my-org/my-repo"); // → "my-org%2Fmy-repo"
 * ```
 */
export function encodeProjectPath(fullName: string): string {
  return encodeURIComponent(fullName);
}

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
 * Updates module-level rate-limit state from response headers.
 *
 * Reads `RateLimit-Remaining` and `RateLimit-Reset` headers and updates
 * {@link _rateLimitRemaining} and {@link _rateLimitReset} accordingly.
 *
 * @param headers - HTTP response headers from a GitLab API response.
 */
function updateRateLimitState(headers: Headers): void {
  const remaining = headers.get("RateLimit-Remaining");
  const reset = headers.get("RateLimit-Reset");

  if (remaining !== null) {
    const parsed = Number(remaining);
    if (!Number.isNaN(parsed)) {
      _rateLimitRemaining = parsed;
    }
  }

  if (reset !== null) {
    const parsed = Number(reset);
    if (!Number.isNaN(parsed)) {
      _rateLimitReset = parsed;
    }
  }
}

/**
 * Maps a GitLab pipeline status string to the normalised `PipelineStatus`.
 *
 * Unknown statuses default to `"pending"`.
 *
 * @param raw - Status string from the GitLab pipelines API.
 * @returns Normalised `PipelineStatus` value.
 */
function mapPipelineStatus(raw: string): PipelineStatus {
  switch (raw) {
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "pending":
    case "scheduled":
    case "blocked":
    case "skipping":
    default:
      return "pending";
  }
}

/**
 * Maps a GitLab issue state string to the normalised `IssueState`.
 *
 * @param raw - State string from the GitLab issues API (`"opened"` or `"closed"`).
 * @returns Normalised `IssueState` value.
 */
function mapIssueState(raw: string): IssueState {
  return raw === "closed" ? "closed" : "open";
}

/**
 * Maps a GitLab MR state string to the normalised `PRState`.
 *
 * GitLab states: `"opened"` → `"open"`, `"merged"` → `"merged"`,
 * everything else (including `"closed"`, `"locked"`) → `"closed"`.
 *
 * @param raw - State string from the GitLab merge requests API.
 * @returns Normalised `PRState` value.
 */
function mapMRState(raw: string): PRState {
  switch (raw) {
    case "opened":
      return "open";
    case "merged":
      return "merged";
    default:
      return "closed";
  }
}

// ---------------------------------------------------------------------------
// Error building
// ---------------------------------------------------------------------------

/**
 * Builds a typed `ApiError` from a non-OK GitLab HTTP response.
 *
 * Reads the response body to extract GitLab's `message` field. Checks
 * `RateLimit-Remaining` on 403 responses to distinguish rate-limit
 * exhaustion from permission errors. Populates `retryAfter` from
 * `RateLimit-Reset` or `Retry-After` headers where applicable.
 *
 * @param resp - The failed fetch `Response` object (must be non-2xx).
 * @returns A fully populated `ApiError` instance ready to throw.
 */
async function buildApiError(resp: Response): Promise<ApiError> {
  const { status } = resp;

  // Update rate-limit counters even from error responses.
  updateRateLimitState(resp.headers);

  let bodyMsg = "";
  try {
    const text = await resp.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    // GitLab uses both "message" and "error" fields.
    if (typeof json["message"] === "string") {
      bodyMsg = json["message"];
    } else if (typeof json["error"] === "string") {
      bodyMsg = json["error"];
    }
  } catch {
    // Ignore body parse failures — bodyMsg stays empty.
  }

  if (status === 401) {
    return new ApiError({
      platform: "gitlab",
      status,
      code: "auth_failed",
      message: "GitLab token is invalid or expired. Please reconnect in settings.",
    });
  }

  if (status === 403) {
    // On GitLab, an exhausted rate limit returns 403 with rate-limit headers.
    const remaining = resp.headers.get("RateLimit-Remaining");
    if (remaining === "0") {
      const resetHeader = resp.headers.get("RateLimit-Reset");
      const retryAfter = resetHeader !== null
        ? Math.max(0, Number(resetHeader) - Math.floor(Date.now() / 1_000))
        : undefined;
      const payload: ApiErrorPayload = {
        platform: "gitlab",
        status,
        code: "rate_limited",
        message: "GitLab API rate limit exhausted. Requests will resume automatically.",
      };
      if (retryAfter !== undefined) payload.retryAfter = retryAfter;
      return new ApiError(payload);
    }
    return new ApiError({
      platform: "gitlab",
      status,
      code: "forbidden",
      message: bodyMsg ||
        "Access forbidden. You may not have permission to access this resource.",
    });
  }

  if (status === 404) {
    return new ApiError({
      platform: "gitlab",
      status,
      code: "not_found",
      message: bodyMsg || "Resource not found.",
    });
  }

  if (status === 422) {
    return new ApiError({
      platform: "gitlab",
      status,
      code: "validation",
      message: bodyMsg || "Request validation failed.",
    });
  }

  if (status === 429) {
    const retryAfterHeader = resp.headers.get("Retry-After");
    const retryAfter = retryAfterHeader !== null ? Number(retryAfterHeader) : undefined;
    const payload: ApiErrorPayload = {
      platform: "gitlab",
      status,
      code: "rate_limited",
      message: "GitLab API rate limit exceeded.",
    };
    if (retryAfter !== undefined) payload.retryAfter = retryAfter;
    return new ApiError(payload);
  }

  // 5xx and any other unexpected status codes.
  return new ApiError({
    platform: "gitlab",
    status,
    code: "server_error",
    message: bodyMsg || `GitLab server error (HTTP ${status}).`,
  });
}

// ---------------------------------------------------------------------------
// Core HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Performs a single authenticated GitLab API request, retrying transient
 * errors (5xx responses and network failures) with exponential back-off.
 *
 * Retries up to {@link MAX_RETRIES} times (1 s then 3 s delay). 4xx errors
 * are never retried. On a 204 No Content response, returns an empty object
 * cast to `T`. Rate-limit headers are tracked on every successful response.
 *
 * @typeParam T - Expected shape of the parsed JSON response body.
 * @param token - GitLab personal access token.
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
        "PRIVATE-TOKEN": token,
        "Accept": "application/json",
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
        platform: "gitlab",
        status: 0,
        code: "network",
        message: `Network error contacting GitLab: ${
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

    // Update rate-limit state on every successful response.
    updateRateLimitState(resp.headers);

    if (resp.status === 204) {
      return [{} as T, resp.headers];
    }

    const data = await resp.json() as T;
    return [data, resp.headers];
  }

  throw lastError ?? new ApiError({
    platform: "gitlab",
    status: 0,
    code: "network",
    message: "Request failed after all retries.",
  });
}

/**
 * Fetches all pages of a paginated GitLab list endpoint by following
 * the `X-Next-Page` response header.
 *
 * Stops when there is no next-page value or `maxPages` pages have been
 * fetched (clamped to {@link MAX_PAGES_LIMIT}).
 *
 * @typeParam T - Element type of the array returned on each page.
 * @param token - GitLab personal access token.
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

    const nextPage = pageResult[1].get("X-Next-Page");
    if (nextPage !== null && nextPage !== "") {
      // Build the next page URL by replacing or appending the `page` param.
      const currentUrl: string = nextUrl;
      const parsedUrl: URL = new URL(currentUrl);
      parsedUrl.searchParams.set("page", nextPage);
      nextUrl = parsedUrl.toString();
    } else {
      nextUrl = undefined;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalises a raw GitLab project object to a unified `Repo`.
 *
 * `openPRCount` (open MR count) is not returned by the projects list endpoint;
 * callers that know the value may supply it; otherwise it defaults to `0`.
 *
 * @param raw - Raw JSON object from the GitLab projects API.
 * @param openPRCount - Known open-MR count; defaults to `0`.
 * @returns Normalised `Repo` value.
 */
function normalizeProject(raw: RawGLProject, openPRCount = 0): Repo {
  const repo: Repo = {
    id: String(raw.id),
    platform: "gitlab",
    fullName: raw.path_with_namespace,
    url: raw.web_url,
    defaultBranch: raw.default_branch ?? "main",
    isPrivate: raw.visibility === "private" || raw.visibility === "internal",
    starCount: raw.star_count,
    openIssueCount: raw.open_issues_count,
    openPRCount,
  };
  if (raw.predominant_language !== null && raw.predominant_language !== undefined) {
    repo.language = raw.predominant_language;
  }
  if (raw.description !== null && raw.description !== "") {
    repo.description = raw.description;
  }
  return repo;
}

/**
 * Normalises a raw GitLab merge request object to a unified `PullRequest`.
 *
 * Draft status is derived from the `draft` boolean field (GitLab ≥ 14.x)
 * with fallback to the legacy `work_in_progress` flag for older instances.
 *
 * The `additions`, `deletions`, and `changedFiles` fields are only populated
 * by the single-MR endpoint (`getMR`); the list endpoint returns `null`/`0`
 * for these fields.
 *
 * Exported for unit testing of type-normalisation logic. Production callers
 * should prefer the high-level `listMRs` / `getMR` functions.
 *
 * @param raw - Raw JSON object from the GitLab merge requests API.
 * @param repoFullName - `owner/repo` path of the containing project.
 * @returns Normalised `PullRequest` value.
 */
export function normalizeMR(raw: RawGLMR, repoFullName: string): PullRequest {
  const isDraft: boolean = raw.draft || raw.work_in_progress;
  const state: PRState = mapMRState(raw.state);

  const pr: PullRequest = {
    id: String(raw.id),
    platform: "gitlab",
    repo: repoFullName,
    number: raw.iid,
    title: raw.title,
    state,
    isDraft,
    author: raw.author?.username ?? "unknown",
    assignees: raw.assignees.map((u) => u.username),
    reviewers: raw.reviewers.map((u) => u.username),
    labels: raw.labels,
    sourceBranch: raw.source_branch,
    targetBranch: raw.target_branch,
    url: raw.web_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    commentCount: raw.user_notes_count,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changes_count !== null ? Number(raw.changes_count) : 0,
  };

  if (raw.description !== null) pr.body = raw.description;

  return pr;
}

/**
 * Normalises a raw GitLab issue object to a unified `Issue`.
 *
 * @param raw - Raw JSON object from the GitLab issues API.
 * @param repoFullName - `owner/repo` path of the containing project.
 * @returns Normalised `Issue` value.
 */
function normalizeIssue(raw: RawGLIssue, repoFullName: string): Issue {
  const issue: Issue = {
    id: String(raw.id),
    platform: "gitlab",
    repo: repoFullName,
    number: raw.iid,
    title: raw.title,
    state: mapIssueState(raw.state),
    author: raw.author?.username ?? "unknown",
    assignees: raw.assignees.map((u) => u.username),
    labels: raw.labels,
    url: raw.web_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    commentCount: raw.user_notes_count,
  };
  if (raw.description !== null && raw.description !== "") {
    issue.body = raw.description;
  }
  return issue;
}

/**
 * Normalises a raw GitLab pipeline object to a unified `Pipeline`.
 *
 * Accepts both the standard pipeline shape and the trigger-pipeline response
 * shape, which omits the optional `name` field.
 *
 * Exported for unit testing of type-normalisation logic. Production callers
 * should prefer the high-level `listPipelines` / `triggerPipeline` functions.
 *
 * @param raw - Raw JSON object from the GitLab pipelines API.
 * @param repoFullName - `owner/repo` path of the containing project.
 * @returns Normalised `Pipeline` value.
 */
export function normalizePipeline(
  raw: RawGLPipeline | RawGLTriggerPipelineResponse,
  repoFullName: string,
): Pipeline {
  const pipeline: Pipeline = {
    id: String(raw.id),
    platform: "gitlab",
    repo: repoFullName,
    name: ("name" in raw && raw.name !== null && raw.name !== undefined)
      ? raw.name
      : `Pipeline #${raw.id}`,
    status: mapPipelineStatus(raw.status),
    branch: raw.ref,
    commitSha: raw.sha,
    url: raw.web_url,
  };

  if (raw.started_at !== null && raw.started_at !== undefined) {
    pipeline.startedAt = raw.started_at;
  }
  if (raw.finished_at !== null && raw.finished_at !== undefined) {
    pipeline.finishedAt = raw.finished_at;
  }
  if (raw.duration !== null && raw.duration !== undefined) {
    pipeline.durationSeconds = raw.duration;
  }

  return pipeline;
}

/**
 * Normalises a raw GitLab note (comment) object to a unified `Comment`.
 *
 * @param raw - Raw JSON object from the GitLab notes API.
 * @param repoFullName - `owner/repo` path of the containing project.
 * @returns Normalised `Comment` value.
 */
function normalizeNote(raw: RawGLNote, repoFullName: string): Comment {
  return {
    id: String(raw.id),
    platform: "gitlab",
    repo: repoFullName,
    issueNumber: raw.noteable_iid,
    author: raw.author.username,
    body: raw.body,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    url: "",
  };
}

// ---------------------------------------------------------------------------
// Public API — Project / Repository
// ---------------------------------------------------------------------------

/**
 * Lists all GitLab projects the authenticated user is a member of.
 *
 * Results are sorted by last activity (descending). Fetches up to `maxPages`
 * pages of 100 items each.
 *
 * @param token - GitLab personal access token.
 * @param maxPages - Maximum pages to fetch (default 3, max 10).
 * @returns Array of normalised `Repo` objects.
 * @throws `ApiError` on authentication, permission, or network failures.
 */
export async function listProjects(
  token: string,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<Repo[]> {
  const url =
    `${BASE_URL}/projects?membership=true&per_page=100&order_by=last_activity_at&sort=desc`;
  const raws = await paginate<RawGLProject>(token, url, maxPages);
  return raws.map((r) => normalizeProject(r));
}

/**
 * Fetches a single GitLab project by its URL-encoded namespace path.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @returns Normalised `Repo` object.
 * @throws `ApiError` on authentication, permission, not-found, or network failures.
 */
export async function getProject(token: string, projectId: string): Promise<Repo> {
  const url = `${BASE_URL}/projects/${projectId}`;
  const [raw] = await request<RawGLProject>(token, url);
  return normalizeProject(raw);
}

// ---------------------------------------------------------------------------
// Public API — Merge Requests
// ---------------------------------------------------------------------------

/**
 * Lists merge requests for a GitLab project.
 *
 * Supports filtering by state and optional `updatedAfter` timestamp for
 * incremental polling. Draft status is derived from the `draft` field (GitLab
 * ≥ 14.x) with fallback to the legacy `work_in_progress` flag.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param opts - Optional filters.
 * @param opts.state - MR lifecycle state filter; defaults to `"opened"`.
 * @param opts.updatedAfter - ISO 8601 timestamp; only return MRs updated after this time.
 * @param opts.maxPages - Maximum pages to fetch (default 3, max 10).
 * @returns Array of normalised `PullRequest` objects.
 * @throws `ApiError` on authentication, permission, or network failures.
 */
export async function listMRs(
  token: string,
  projectId: string,
  opts: {
    state?: "opened" | "closed" | "locked" | "merged" | "all";
    updatedAfter?: string;
    maxPages?: number;
  } = {},
): Promise<PullRequest[]> {
  const params = new URLSearchParams({
    per_page: "100",
    state: opts.state ?? "opened",
    order_by: "updated_at",
    sort: "desc",
  });
  if (opts.updatedAfter !== undefined) {
    params.set("updated_after", opts.updatedAfter);
  }

  const url = `${BASE_URL}/projects/${projectId}/merge_requests?${params}`;
  const raws = await paginate<RawGLMR>(token, url, opts.maxPages ?? DEFAULT_MAX_PAGES);

  // Decode project path back for use in normalised objects.
  const repoFullName = decodeURIComponent(projectId);
  return raws.map((r) => normalizeMR(r, repoFullName));
}

/**
 * Fetches a single merge request by its internal IID (project-scoped number).
 *
 * The single-MR endpoint returns `additions` and `deletions` fields that are
 * absent from the list endpoint.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param mrIid - MR IID (project-scoped merge request number).
 * @returns Normalised `PullRequest` object with additions/deletions populated.
 * @throws `ApiError` on authentication, permission, not-found, or network failures.
 */
export async function getMR(
  token: string,
  projectId: string,
  mrIid: number,
): Promise<PullRequest> {
  const url =
    `${BASE_URL}/projects/${projectId}/merge_requests/${mrIid}?include_diff_stats=true`;
  const [raw] = await request<RawGLMR>(token, url);
  return normalizeMR(raw, decodeURIComponent(projectId));
}

/**
 * Creates a new merge request in a GitLab project.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param params - MR creation parameters.
 * @param params.title - Title of the merge request.
 * @param params.sourceBranch - Branch to merge from.
 * @param params.targetBranch - Branch to merge into.
 * @param params.description - Optional MR description/body.
 * @param params.draft - Whether to create the MR as a draft.
 * @param params.assigneeIds - Optional list of GitLab user IDs to assign.
 * @param params.reviewerIds - Optional list of GitLab user IDs to request review from.
 * @param params.labels - Optional list of label names to apply.
 * @returns Normalised `PullRequest` representing the created MR.
 * @throws `ApiError` on authentication, permission, validation, or network failures.
 */
export async function createMR(
  token: string,
  projectId: string,
  params: {
    title: string;
    sourceBranch: string;
    targetBranch: string;
    description?: string;
    draft?: boolean;
    assigneeIds?: number[];
    reviewerIds?: number[];
    labels?: string[];
  },
): Promise<PullRequest> {
  const body: Record<string, unknown> = {
    title: params.draft === true ? `Draft: ${params.title}` : params.title,
    source_branch: params.sourceBranch,
    target_branch: params.targetBranch,
  };
  if (params.description !== undefined) body.description = params.description;
  if (params.assigneeIds !== undefined) {
    if (params.assigneeIds.length === 1) {
      body.assignee_id = params.assigneeIds[0];
    } else if (params.assigneeIds.length > 1) {
      body.assignee_ids = params.assigneeIds;
    }
  }
  if (params.reviewerIds !== undefined) body.reviewer_ids = params.reviewerIds;
  if (params.labels !== undefined) body.labels = params.labels.join(",");

  const url = `${BASE_URL}/projects/${projectId}/merge_requests`;
  const [raw] = await request<RawGLMR>(token, url, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return normalizeMR(raw, decodeURIComponent(projectId));
}

/**
 * Merges an open merge request.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param mrIid - MR IID (project-scoped merge request number).
 * @param opts - Optional merge options.
 * @param opts.mergeCommitMessage - Custom merge commit message.
 * @param opts.squash - Whether to squash commits into a single commit on merge.
 * @param opts.shouldRemoveSourceBranch - Whether to delete the source branch after merge.
 * @returns `void` on success.
 * @throws `ApiError` on authentication, permission, validation, or network failures.
 */
export async function mergeMR(
  token: string,
  projectId: string,
  mrIid: number,
  opts: {
    mergeCommitMessage?: string;
    squash?: boolean;
    shouldRemoveSourceBranch?: boolean;
  } = {},
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.mergeCommitMessage !== undefined) {
    body.merge_commit_message = opts.mergeCommitMessage;
  }
  if (opts.squash !== undefined) body.squash = opts.squash;
  if (opts.shouldRemoveSourceBranch !== undefined) {
    body.should_remove_source_branch = opts.shouldRemoveSourceBranch;
  }

  const url = `${BASE_URL}/projects/${projectId}/merge_requests/${mrIid}/merge`;
  await request<Record<string, unknown>>(token, url, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/**
 * Lists approvals for a merge request, normalised to `Review[]`.
 *
 * **Limitation:** GitLab's approval model differs fundamentally from GitHub's.
 * This function returns one `Review` per approver with `state: "approved"`.
 * There is no native `changes_requested` state in GitLab; that information
 * must be inferred from unresolved MR discussions/threads, which this function
 * does not fetch. The `body` field is always `undefined` because GitLab
 * approvals carry no review body text.
 *
 * To obtain a full picture of reviewer feedback on GitLab, supplement this
 * call with MR notes/discussions.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param mrIid - MR IID (project-scoped merge request number).
 * @returns Array of normalised `Review` objects (one per approver).
 * @throws `ApiError` on authentication, permission, not-found, or network failures.
 */
export async function listMRApprovals(
  token: string,
  projectId: string,
  mrIid: number,
): Promise<Review[]> {
  const url = `${BASE_URL}/projects/${projectId}/merge_requests/${mrIid}/approvals`;
  const [raw] = await request<RawGLApprovals>(token, url);

  const repoFullName = decodeURIComponent(projectId);

  return raw.approved_by.map((entry): Review => {
    const reviewState: ReviewState = "approved";
    return {
      id: `${raw.id}-${entry.user.username}`,
      platform: "gitlab",
      prNumber: raw.iid,
      repo: repoFullName,
      reviewer: entry.user.username,
      state: reviewState,
      submittedAt: raw.created_at,
      url: raw.web_url,
    };
  });
}

/**
 * Posts a new note (comment) on a merge request.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param mrIid - MR IID (project-scoped merge request number).
 * @param body - Comment text (Markdown supported).
 * @returns Normalised `Comment` object representing the created note.
 * @throws `ApiError` on authentication, permission, validation, or network failures.
 */
export async function createMRNote(
  token: string,
  projectId: string,
  mrIid: number,
  body: string,
): Promise<Comment> {
  const url = `${BASE_URL}/projects/${projectId}/merge_requests/${mrIid}/notes`;
  const [raw] = await request<RawGLNote>(token, url, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  return normalizeNote(raw, decodeURIComponent(projectId));
}

// ---------------------------------------------------------------------------
// Public API — Issues
// ---------------------------------------------------------------------------

/**
 * Lists issues for a GitLab project.
 *
 * Supports filtering by state and optional `updatedAfter` timestamp for
 * incremental polling.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param opts - Optional filters.
 * @param opts.state - Issue state filter (`"opened"`, `"closed"`, or `"all"`); defaults to `"opened"`.
 * @param opts.updatedAfter - ISO 8601 timestamp; only return issues updated after this time.
 * @param opts.assigneeUsername - Filter to issues assigned to this username.
 * @param opts.authorUsername - Filter to issues authored by this username.
 * @param opts.maxPages - Maximum pages to fetch (default 3, max 10).
 * @returns Array of normalised `Issue` objects.
 * @throws `ApiError` on authentication, permission, or network failures.
 */
export async function listIssues(
  token: string,
  projectId: string,
  opts: {
    state?: "opened" | "closed" | "all";
    updatedAfter?: string;
    assigneeUsername?: string;
    authorUsername?: string;
    maxPages?: number;
  } = {},
): Promise<Issue[]> {
  const params = new URLSearchParams({
    per_page: "100",
    state: opts.state ?? "opened",
    order_by: "updated_at",
    sort: "desc",
  });
  if (opts.updatedAfter !== undefined) {
    params.set("updated_after", opts.updatedAfter);
  }
  if (opts.assigneeUsername !== undefined) {
    params.set("assignee_username", opts.assigneeUsername);
  }
  if (opts.authorUsername !== undefined) {
    params.set("author_username", opts.authorUsername);
  }

  const url = `${BASE_URL}/projects/${projectId}/issues?${params}`;
  const raws = await paginate<RawGLIssue>(token, url, opts.maxPages ?? DEFAULT_MAX_PAGES);
  const repoFullName = decodeURIComponent(projectId);
  return raws.map((r) => normalizeIssue(r, repoFullName));
}

/**
 * Creates a new issue in a GitLab project.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param params - Issue creation parameters.
 * @param params.title - Issue title.
 * @param params.description - Optional issue body (Markdown supported).
 * @param params.labels - Optional array of label names to apply.
 * @param params.assigneeIds - Optional array of GitLab user IDs to assign.
 * @returns Normalised `Issue` representing the created issue.
 * @throws `ApiError` on authentication, permission, validation, or network failures.
 */
export async function createIssue(
  token: string,
  projectId: string,
  params: {
    title: string;
    description?: string;
    labels?: string[];
    assigneeIds?: number[];
  },
): Promise<Issue> {
  const body: Record<string, unknown> = { title: params.title };
  if (params.description !== undefined) body.description = params.description;
  if (params.labels !== undefined) body.labels = params.labels.join(",");
  if (params.assigneeIds !== undefined) body.assignee_ids = params.assigneeIds;

  const url = `${BASE_URL}/projects/${projectId}/issues`;
  const [raw] = await request<RawGLIssue>(token, url, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return normalizeIssue(raw, decodeURIComponent(projectId));
}

/**
 * Updates an existing issue in a GitLab project.
 *
 * Only supplied fields are updated; omitted fields leave the issue unchanged.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param issueIid - Issue IID (project-scoped issue number).
 * @param params - Fields to update.
 * @param params.title - New issue title.
 * @param params.description - New issue body.
 * @param params.state - Set to `"close"` to close the issue, `"reopen"` to reopen it.
 * @param params.labels - New label list (replaces existing labels).
 * @param params.assigneeIds - New assignee list (replaces existing; empty array removes all).
 * @returns Normalised `Issue` with updated fields.
 * @throws `ApiError` on authentication, permission, not-found, validation, or network failures.
 */
export async function updateIssue(
  token: string,
  projectId: string,
  issueIid: number,
  params: {
    title?: string;
    description?: string;
    state?: "close" | "reopen";
    labels?: string[];
    assigneeIds?: number[];
  },
): Promise<Issue> {
  const body: Record<string, unknown> = {};
  if (params.title !== undefined) body.title = params.title;
  if (params.description !== undefined) body.description = params.description;
  if (params.state !== undefined) body.state_event = params.state;
  if (params.labels !== undefined) body.labels = params.labels.join(",");
  if (params.assigneeIds !== undefined) body.assignee_ids = params.assigneeIds;

  const url = `${BASE_URL}/projects/${projectId}/issues/${issueIid}`;
  const [raw] = await request<RawGLIssue>(token, url, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return normalizeIssue(raw, decodeURIComponent(projectId));
}

// ---------------------------------------------------------------------------
// Public API — Branches
// ---------------------------------------------------------------------------

/**
 * Lists all branches for a GitLab project.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param maxPages - Maximum pages to fetch (default 3, max 10).
 * @returns Array of normalised `Branch` objects.
 * @throws `ApiError` on authentication, permission, or network failures.
 */
export async function listBranches(
  token: string,
  projectId: string,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<Branch[]> {
  const url = `${BASE_URL}/projects/${projectId}/repository/branches?per_page=100`;
  const raws = await paginate<RawGLBranch>(token, url, maxPages);
  return raws.map((r): Branch => ({
    name: r.name,
    isProtected: r.protected,
    lastCommitSha: r.commit.id,
  }));
}

// ---------------------------------------------------------------------------
// Public API — Pipelines
// ---------------------------------------------------------------------------

/**
 * Lists CI/CD pipelines for a GitLab project.
 *
 * Supports optional `updatedAfter` timestamp for incremental polling.
 * Results are sorted by ID (most recent first).
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param opts - Optional filters.
 * @param opts.updatedAfter - ISO 8601 timestamp; only return pipelines updated after this time.
 * @param opts.ref - Filter pipelines to a specific branch or tag name.
 * @param opts.status - Filter by pipeline status.
 * @param opts.maxPages - Maximum pages to fetch (default 3, max 10).
 * @returns Array of normalised `Pipeline` objects.
 * @throws `ApiError` on authentication, permission, or network failures.
 */
export async function listPipelines(
  token: string,
  projectId: string,
  opts: {
    updatedAfter?: string;
    ref?: string;
    status?: string;
    maxPages?: number;
  } = {},
): Promise<Pipeline[]> {
  const params = new URLSearchParams({ per_page: "100", order_by: "id", sort: "desc" });
  if (opts.updatedAfter !== undefined) params.set("updated_after", opts.updatedAfter);
  if (opts.ref !== undefined) params.set("ref", opts.ref);
  if (opts.status !== undefined) params.set("status", opts.status);

  const url = `${BASE_URL}/projects/${projectId}/pipelines?${params}`;
  const raws = await paginate<RawGLPipeline>(
    token,
    url,
    opts.maxPages ?? DEFAULT_MAX_PAGES,
  );
  const repoFullName = decodeURIComponent(projectId);
  return raws.map((r) => normalizePipeline(r, repoFullName));
}

/**
 * Triggers a new CI/CD pipeline for a specific branch or ref.
 *
 * Requires the token to have at least Developer access on the project.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param ref - Branch name, tag name, or commit SHA to run the pipeline on.
 * @param variables - Optional key/value pairs passed as pipeline variables.
 * @returns Normalised `Pipeline` representing the triggered run.
 * @throws `ApiError` on authentication, permission, validation, or network failures.
 */
export async function triggerPipeline(
  token: string,
  projectId: string,
  ref: string,
  variables?: Record<string, string>,
): Promise<Pipeline> {
  const body: Record<string, unknown> = { ref };
  if (variables !== undefined) {
    body.variables = Object.entries(variables).map(([key, value]) => ({
      key,
      value,
      variable_type: "env_var",
    }));
  }

  const url = `${BASE_URL}/projects/${projectId}/pipeline`;
  const [raw] = await request<RawGLTriggerPipelineResponse>(token, url, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return normalizePipeline(raw, decodeURIComponent(projectId));
}

// ---------------------------------------------------------------------------
// Public API — Code Search
// ---------------------------------------------------------------------------

/**
 * Searches for code within a specific GitLab project (project-scoped blobs search).
 *
 * GitLab's code search is always project-scoped; to search across multiple
 * projects, iterate over each project separately (the capability layer caps
 * this at 10 projects). Results include a short matched fragment and the
 * 1-based start line.
 *
 * @param token - GitLab personal access token.
 * @param projectId - URL-encoded project namespace path (e.g. `"owner%2Frepo"`).
 * @param query - Search query string.
 * @param opts - Optional search options.
 * @param opts.ref - Branch or tag to scope the search to (defaults to default branch).
 * @param opts.maxPages - Maximum pages to fetch (default 3, max 10).
 * @returns Array of normalised `CodeResult` objects.
 * @throws `ApiError` on authentication, permission, or network failures.
 */
export async function searchCode(
  token: string,
  projectId: string,
  query: string,
  opts: {
    ref?: string;
    maxPages?: number;
  } = {},
): Promise<CodeResult[]> {
  const params = new URLSearchParams({
    scope: "blobs",
    search: query,
    per_page: "100",
  });
  if (opts.ref !== undefined) params.set("ref", opts.ref);

  const url = `${BASE_URL}/projects/${projectId}/search?${params}`;
  const raws = await paginate<RawGLCodeBlob>(
    token,
    url,
    opts.maxPages ?? DEFAULT_MAX_PAGES,
  );

  const repoFullName = decodeURIComponent(projectId);

  return raws.map((r): CodeResult => {
    // Construct a web URL pointing to the file (and line if available).
    const decodedId = decodeURIComponent(projectId);
    // The project web_url is not available here; use the path we know.
    const fileWebUrl =
      `https://gitlab.com/${decodedId}/-/blob/${r.ref}/${r.path}#L${r.startline}`;

    return {
      path: r.path,
      repo: repoFullName,
      platform: "gitlab",
      url: fileWebUrl,
      fragment: r.data,
      lineNumber: r.startline,
    };
  });
}
