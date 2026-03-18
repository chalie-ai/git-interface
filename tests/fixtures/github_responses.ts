/**
 * @module tests/fixtures/github_responses
 *
 * Realistic raw GitHub REST API response shapes as returned by `fetch()` before
 * normalisation. These objects mirror the actual JSON bodies GitHub sends and
 * are used to exercise the type-normalisation helpers in isolation, without
 * making any network calls.
 *
 * Each fixture documents which normalisation behaviour it exercises:
 * - {@link RAW_GH_PR_DRAFT}       — draft flag maps to `isDraft=true, state="open"`
 * - {@link RAW_GH_PR_MERGED}      — `merged_at` present maps to `state="merged"`
 * - {@link RAW_GH_ISSUE_IS_PR}    — `pull_request` key must be filtered before normalise
 * - {@link RAW_GH_ISSUE_NORMAL}   — regular issue normalises to domain `Issue`
 * - {@link RAW_GH_WORKFLOW_RUN_SUCCESS} — completed success run normalises to `Pipeline`
 * - {@link RAW_GH_WORKFLOW_RUN_IN_PROGRESS} — in-progress run maps to `status="running"`
 */

// ---------------------------------------------------------------------------
// Pull Requests
// ---------------------------------------------------------------------------

/**
 * A draft pull request (open, not yet ready for review).
 *
 * Key fields under test:
 * - `draft: true` → `isDraft: true`
 * - `state: "open"` + `merged_at: null` → `state: "open"`
 * - `additions`, `deletions`, `changed_files` present (single-PR endpoint shape)
 */
export const RAW_GH_PR_DRAFT = {
  id: 100_001,
  number: 10,
  title: "WIP: Refactor authentication module",
  body: "Work in progress – please do not merge yet.",
  state: "open",
  draft: true,
  user: { login: "alice" },
  assignees: [] as { login: string }[],
  requested_reviewers: [] as { login: string }[],
  labels: [{ name: "wip" }],
  head: { ref: "feature/auth-refactor", sha: "aaa111bbb222ccc3" },
  base: { ref: "main", sha: "ccc333ddd444eee5" },
  html_url: "https://github.com/acme/backend/pull/10",
  created_at: "2026-03-15T08:00:00Z",
  updated_at: "2026-03-17T10:00:00Z",
  merged_at: null as string | null,
  comments: 0,
  review_comments: 0,
  additions: 200,
  deletions: 50,
  changed_files: 12,
};

/**
 * A merged pull request (state "closed" on the wire, `merged_at` is populated).
 *
 * Key fields under test:
 * - `merged_at` is non-null → normaliser returns `state: "merged"` regardless of `state`
 * - `draft: false` → `isDraft: false`
 * - Optional `mergeable_state` is present
 */
export const RAW_GH_PR_MERGED = {
  id: 100_002,
  number: 9,
  title: "Fix memory leak in WebSocket handler",
  body: "Closes #45. Resolves a handler that was not cleaned up on disconnect.",
  state: "closed",
  draft: false,
  user: { login: "bob" },
  assignees: [{ login: "carol" }],
  requested_reviewers: [] as { login: string }[],
  labels: [{ name: "bug" }, { name: "performance" }],
  head: { ref: "fix/ws-memory-leak", sha: "fff000eee999ddd8" },
  base: { ref: "main", sha: "ccc333ddd444eee5" },
  html_url: "https://github.com/acme/backend/pull/9",
  created_at: "2026-03-10T12:00:00Z",
  updated_at: "2026-03-14T16:30:00Z",
  merged_at: "2026-03-14T16:30:00Z" as string | null,
  mergeable_state: "clean",
  comments: 3,
  review_comments: 5,
  additions: 45,
  deletions: 120,
  changed_files: 6,
};

/**
 * An open non-draft pull request with requested reviewers.
 *
 * Useful as a baseline for verifying that `isDraft=false` and `state="open"`
 * when neither draft flag is set nor `merged_at` is populated.
 */
export const RAW_GH_PR_OPEN = {
  id: 100_003,
  number: 11,
  title: "Add rate-limiting middleware",
  body: "Implements token-bucket rate limiting at the ingress layer.",
  state: "open",
  draft: false,
  user: { login: "dave" },
  assignees: [] as { login: string }[],
  requested_reviewers: [{ login: "alice" }, { login: "bob" }],
  labels: [{ name: "feature" }],
  head: { ref: "feat/rate-limit", sha: "111aaa222bbb333c" },
  base: { ref: "main", sha: "ccc333ddd444eee5" },
  html_url: "https://github.com/acme/backend/pull/11",
  created_at: "2026-03-16T09:00:00Z",
  updated_at: "2026-03-18T07:30:00Z",
  merged_at: null as string | null,
  comments: 2,
  review_comments: 1,
  additions: 310,
  deletions: 18,
  changed_files: 9,
};

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/**
 * An issue-endpoint item that is actually a pull request.
 *
 * GitHub's `GET /repos/{owner}/{repo}/issues` returns both real issues and
 * pull requests. Items with a `pull_request` key present must be filtered out
 * before normalisation. This fixture has that key set.
 *
 * Key field under test:
 * - `pull_request` key is present → item must NOT appear in normalised issue list
 */
export const RAW_GH_ISSUE_IS_PR = {
  id: 200_001,
  number: 11,
  title: "Add rate-limiting middleware",
  body: null as string | null,
  state: "open",
  user: { login: "dave" },
  assignees: [] as { login: string }[],
  labels: [{ name: "feature" }],
  html_url: "https://github.com/acme/backend/pull/11",
  created_at: "2026-03-16T09:00:00Z",
  updated_at: "2026-03-17T11:00:00Z",
  comments: 2,
  /** Presence of this key signals the item is a PR, not a true issue. */
  pull_request: {
    url: "https://api.github.com/repos/acme/backend/pulls/11",
    html_url: "https://github.com/acme/backend/pull/11",
    diff_url: "https://github.com/acme/backend/pull/11.diff",
    patch_url: "https://github.com/acme/backend/pull/11.patch",
    merged_at: null,
  },
};

/**
 * A genuine repository issue (no `pull_request` key).
 *
 * Key fields under test:
 * - `pull_request` key is absent → item MUST appear in normalised issue list
 * - `state: "open"` → normalised `state: "open"`
 * - `assignees` and `labels` arrays are normalised correctly
 */
export const RAW_GH_ISSUE_NORMAL = {
  id: 200_002,
  number: 12,
  title: "Database connection pool exhausted under sustained load",
  body: "Steps to reproduce: run the integration test suite with 500 concurrent users.",
  state: "open",
  user: { login: "carol" },
  assignees: [{ login: "alice" }],
  labels: [{ name: "bug" }, { name: "performance" }],
  html_url: "https://github.com/acme/backend/issues/12",
  created_at: "2026-03-17T07:00:00Z",
  updated_at: "2026-03-18T09:00:00Z",
  comments: 4,
};

// ---------------------------------------------------------------------------
// Workflow Runs (GitHub Actions pipelines)
// ---------------------------------------------------------------------------

/**
 * A completed, successful GitHub Actions workflow run.
 *
 * Key fields under test:
 * - `status: "completed"`, `conclusion: "success"` → `Pipeline.status: "success"`
 * - `run_started_at` and `updated_at` both set → `durationSeconds` computed
 * - `name` is non-null → used as-is for `Pipeline.name`
 */
export const RAW_GH_WORKFLOW_RUN_SUCCESS = {
  id: 300_001,
  name: "CI / integration-tests",
  status: "completed",
  conclusion: "success" as string | null,
  head_branch: "main" as string | null,
  head_sha: "abc123000111abc1def2",
  html_url: "https://github.com/acme/backend/actions/runs/300001",
  run_started_at: "2026-03-18T08:00:00Z" as string | null,
  updated_at: "2026-03-18T08:12:00Z",
};

/**
 * An in-progress GitHub Actions workflow run.
 *
 * Key fields under test:
 * - `status: "in_progress"` → `Pipeline.status: "running"`
 * - `conclusion: null` (not finished) → no conclusion mapping applied
 * - `run_started_at` set but `status !== "completed"` → no `durationSeconds`
 */
export const RAW_GH_WORKFLOW_RUN_IN_PROGRESS = {
  id: 300_002,
  name: "CI / unit-tests",
  status: "in_progress",
  conclusion: null as string | null,
  head_branch: "feature/auth-refactor" as string | null,
  head_sha: "aaa111bbb222ccc3ddd4",
  html_url: "https://github.com/acme/backend/actions/runs/300002",
  run_started_at: "2026-03-18T09:00:00Z" as string | null,
  updated_at: "2026-03-18T09:03:00Z",
};

/**
 * A completed, failed GitHub Actions workflow run.
 *
 * Key fields under test:
 * - `status: "completed"`, `conclusion: "failure"` → `Pipeline.status: "failed"`
 */
export const RAW_GH_WORKFLOW_RUN_FAILED = {
  id: 300_003,
  name: null as string | null,
  status: "completed",
  conclusion: "failure" as string | null,
  head_branch: "main" as string | null,
  head_sha: "eee555fff666aaa7bbb8",
  html_url: "https://github.com/acme/backend/actions/runs/300003",
  run_started_at: "2026-03-17T22:00:00Z" as string | null,
  updated_at: "2026-03-17T22:08:30Z",
};
