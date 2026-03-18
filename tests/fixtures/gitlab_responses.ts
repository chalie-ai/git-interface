/**
 * @module tests/fixtures/gitlab_responses
 *
 * Realistic raw GitLab REST API v4 response shapes as returned by `fetch()`
 * before normalisation. These objects mirror actual JSON bodies GitLab sends
 * and are used to exercise the type-normalisation helpers in isolation,
 * without making any network calls.
 *
 * Each fixture documents which normalisation behaviour it exercises:
 * - {@link RAW_GL_MR_WIP}          — legacy `work_in_progress=true` maps to `isDraft=true`
 * - {@link RAW_GL_MR_DRAFT_MODERN} — modern `draft=true` maps to `isDraft=true`
 * - {@link RAW_GL_MR_CLOSED}       — `state="closed"` maps to `state="closed"`
 * - {@link RAW_GL_MR_MERGED}       — `state="merged"` maps to `state="merged"`
 * - {@link RAW_GL_PIPELINE_RUNNING}   — `status="running"` maps to `status="running"`
 * - {@link RAW_GL_PIPELINE_SUCCESS}   — `status="success"` with duration maps correctly
 * - {@link RAW_GL_APPROVALS}       — approval response shape for `listMRApprovals`
 */

// ---------------------------------------------------------------------------
// Merge Requests
// ---------------------------------------------------------------------------

/**
 * A merge request using the legacy `work_in_progress` draft flag.
 *
 * Older GitLab instances (pre-14.x) used `work_in_progress: true` to
 * indicate a draft MR. The normaliser must handle this fallback.
 *
 * Key fields under test:
 * - `work_in_progress: true`, `draft: false` → `isDraft: true`
 * - `state: "opened"` → normalised `state: "open"`
 */
export const RAW_GL_MR_WIP = {
  id: 400_001,
  iid: 20,
  title: "WIP: Implement Redis caching layer",
  description: "Still in progress — cache eviction strategy TBD.",
  state: "opened",
  work_in_progress: true,
  draft: false,
  author: { username: "eve" },
  assignees: [] as { username: string }[],
  reviewers: [] as { username: string }[],
  labels: [] as string[],
  source_branch: "feature/redis-cache",
  target_branch: "main",
  web_url: "https://gitlab.example.com/acme/api/-/merge_requests/20",
  created_at: "2026-03-15T10:00:00Z",
  updated_at: "2026-03-17T14:00:00Z",
  merged_at: null as string | null,
  user_notes_count: 1,
  changes_count: "8" as string | number | null,
  additions: null as number | null,
  deletions: null as number | null,
  diff_refs: null as { head_sha: string } | null,
  head_pipeline: null as { id: number; status: string } | null,
  merge_commit_sha: null as string | null,
  sha: "bbb222ccc333ddd444e",
};

/**
 * A merge request using the modern `draft` flag (GitLab ≥ 14.x).
 *
 * Key fields under test:
 * - `draft: true`, `work_in_progress: false` → `isDraft: true`
 * - `state: "opened"` → normalised `state: "open"`
 * - `reviewers` array is normalised to usernames
 */
export const RAW_GL_MR_DRAFT_MODERN = {
  id: 400_002,
  iid: 21,
  title: "Draft: Add GraphQL schema validation middleware",
  description: null as string | null,
  state: "opened",
  work_in_progress: false,
  draft: true,
  author: { username: "frank" },
  assignees: [{ username: "grace" }],
  reviewers: [{ username: "henry" }],
  labels: ["backend", "graphql"] as string[],
  source_branch: "feat/graphql-validation",
  target_branch: "develop",
  web_url: "https://gitlab.example.com/acme/api/-/merge_requests/21",
  created_at: "2026-03-16T14:00:00Z",
  updated_at: "2026-03-18T08:00:00Z",
  merged_at: null as string | null,
  user_notes_count: 0,
  changes_count: null as string | number | null,
  additions: null as number | null,
  deletions: null as number | null,
  diff_refs: { head_sha: "eee555fff666ggg7" },
  head_pipeline: { id: 500_010, status: "running" } as { id: number; status: string } | null,
  merge_commit_sha: null as string | null,
  sha: "eee555fff666ggg777h",
};

/**
 * A closed merge request (manually closed, not merged).
 *
 * Key fields under test:
 * - `state: "closed"` → normalised `state: "closed"`
 * - `draft: false`, `work_in_progress: false` → `isDraft: false`
 */
export const RAW_GL_MR_CLOSED = {
  id: 400_003,
  iid: 19,
  title: "Remove deprecated v1 API endpoints",
  description: "Cleaned up the legacy v1 endpoints per deprecation schedule.",
  state: "closed",
  work_in_progress: false,
  draft: false,
  author: { username: "ivan" },
  assignees: [] as { username: string }[],
  reviewers: [] as { username: string }[],
  labels: ["cleanup"] as string[],
  source_branch: "chore/remove-v1",
  target_branch: "main",
  web_url: "https://gitlab.example.com/acme/api/-/merge_requests/19",
  created_at: "2026-03-08T10:00:00Z",
  updated_at: "2026-03-12T16:00:00Z",
  merged_at: null as string | null,
  user_notes_count: 3,
  changes_count: 15 as string | number | null,
  additions: 0 as number | null,
  deletions: 320 as number | null,
  diff_refs: null as { head_sha: string } | null,
  head_pipeline: null as { id: number; status: string } | null,
  merge_commit_sha: null as string | null,
  sha: "fff111aaa222bbb333c",
};

/**
 * A successfully merged merge request.
 *
 * Key fields under test:
 * - `state: "merged"` → normalised `state: "merged"`
 * - `merge_commit_sha` is populated
 * - `additions` and `deletions` are provided (single-MR endpoint shape)
 */
export const RAW_GL_MR_MERGED = {
  id: 400_004,
  iid: 18,
  title: "Migrate database schema to Alembic",
  description: "Replaces the hand-rolled migration scripts with Alembic.",
  state: "merged",
  work_in_progress: false,
  draft: false,
  author: { username: "judy" },
  assignees: [] as { username: string }[],
  reviewers: [{ username: "ivan" }],
  labels: ["database", "migration"] as string[],
  source_branch: "feat/alembic-migrations",
  target_branch: "main",
  web_url: "https://gitlab.example.com/acme/api/-/merge_requests/18",
  created_at: "2026-03-05T09:00:00Z",
  updated_at: "2026-03-11T17:45:00Z",
  merged_at: "2026-03-11T17:45:00Z" as string | null,
  user_notes_count: 7,
  changes_count: 22 as string | number | null,
  additions: 410 as number | null,
  deletions: 95 as number | null,
  diff_refs: { head_sha: "abc999def888ggg777" },
  head_pipeline: null as { id: number; status: string } | null,
  merge_commit_sha: "zzz000yyy111xxx222" as string | null,
  sha: "abc999def888ggg777h",
};

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

/**
 * A currently running GitLab pipeline.
 *
 * Key fields under test:
 * - `status: "running"` → `Pipeline.status: "running"`
 * - `finished_at: null` and `duration: null` → optional fields absent
 * - `name` is absent (list-endpoint shape; normaliser falls back to `"Pipeline #<id>"`)
 */
export const RAW_GL_PIPELINE_RUNNING = {
  id: 500_001,
  status: "running",
  ref: "main",
  sha: "ddd444eee555fff666g",
  web_url: "https://gitlab.example.com/acme/api/-/pipelines/500001",
  created_at: "2026-03-18T09:00:00Z" as string | null,
  started_at: "2026-03-18T09:01:00Z" as string | null,
  finished_at: null as string | null,
  duration: null as number | null,
};

/**
 * A successfully completed GitLab pipeline with timing data.
 *
 * Key fields under test:
 * - `status: "success"` → `Pipeline.status: "success"`
 * - `duration: 427` → `Pipeline.durationSeconds: 427`
 * - `name` present (detailed single-pipeline endpoint shape)
 */
export const RAW_GL_PIPELINE_SUCCESS = {
  id: 500_002,
  name: "Pipeline for merge request" as string | null | undefined,
  status: "success",
  ref: "feat/alembic-migrations",
  sha: "abc999def888ggg777h",
  web_url: "https://gitlab.example.com/acme/api/-/pipelines/500002",
  created_at: "2026-03-11T17:00:00Z" as string | null,
  started_at: "2026-03-11T17:01:00Z" as string | null,
  finished_at: "2026-03-11T17:08:07Z" as string | null,
  duration: 427 as number | null,
};

/**
 * A cancelled GitLab pipeline.
 *
 * Key fields under test:
 * - `status: "canceled"` (GitLab spelling) → `Pipeline.status: "cancelled"` (normalised)
 */
export const RAW_GL_PIPELINE_CANCELED = {
  id: 500_003,
  status: "canceled",
  ref: "feature/redis-cache",
  sha: "bbb222ccc333ddd444e",
  web_url: "https://gitlab.example.com/acme/api/-/pipelines/500003",
  created_at: "2026-03-17T11:00:00Z" as string | null,
  started_at: "2026-03-17T11:01:00Z" as string | null,
  finished_at: "2026-03-17T11:02:15Z" as string | null,
  duration: 75 as number | null,
};

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * A GitLab MR approvals response for an approved merge request.
 *
 * This shape is returned by `GET /projects/:id/merge_requests/:iid/approvals`.
 * `listMRApprovals` maps each entry in `approved_by` to a `Review` object
 * with `state: "approved"`.
 *
 * Key fields under test (via `listMRApprovals` normalisation logic):
 * - `approved: true`, `approved_by` has one entry → one `Review` produced
 * - `approval_rules_left` is empty → all required approvals satisfied
 */
export const RAW_GL_APPROVALS_APPROVED = {
  id: 400_002,
  iid: 21,
  project_id: 7,
  approved: true,
  approved_by: [{ user: { username: "frank" } }],
  approval_rules_left: [] as { name: string }[],
  created_at: "2026-03-18T08:30:00Z",
  web_url: "https://gitlab.example.com/acme/api/-/merge_requests/21",
};

/**
 * A GitLab MR approvals response for a merge request that still requires review.
 *
 * Key fields:
 * - `approved: false`, `approved_by` is empty → zero `Review` objects produced
 * - `approval_rules_left` has one remaining rule
 */
export const RAW_GL_APPROVALS_PENDING = {
  id: 400_001,
  iid: 20,
  project_id: 7,
  approved: false,
  approved_by: [] as { user: { username: string } }[],
  approval_rules_left: [{ name: "Maintainer approval" }],
  created_at: "2026-03-15T10:00:00Z",
  web_url: "https://gitlab.example.com/acme/api/-/merge_requests/20",
};
