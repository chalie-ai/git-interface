/**
 * @module tests/fixtures/gitlab_events
 *
 * Synthetic GitLab event fixtures for use in classifier unit tests.
 * All objects are inline constants — no network calls are made.
 *
 * Types are drawn from {@link shared/types.ts}. The shapes mirror real
 * GitLab API responses that have been normalised through the GitLab client.
 */

import type { Issue, Pipeline, PullRequest } from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// Merge Requests (normalised as PullRequest)
// ---------------------------------------------------------------------------

/**
 * An open GitLab merge request with a requested reviewer.
 * Used for cross-platform `review_requested` event tests.
 */
export const GL_PR: PullRequest = {
  id: "gl-mr-10",
  platform: "gitlab",
  repo: "mygroup/backend",
  number: 10,
  title: "Implement rate limiting middleware",
  body: "Adds Redis-backed rate limiting using the token-bucket algorithm.",
  state: "open",
  isDraft: false,
  author: "dave",
  assignees: [],
  reviewers: ["eve"],
  labels: ["backend", "performance"],
  sourceBranch: "feature/rate-limit",
  targetBranch: "main",
  url: "https://gitlab.com/mygroup/backend/-/merge_requests/10",
  createdAt: "2026-03-02T00:00:00Z",
  updatedAt: "2026-03-11T00:00:00Z",
  commentCount: 0,
  additions: 85,
  deletions: 10,
  changedFiles: 5,
};

/**
 * A merged GitLab MR. Used for cross-platform `pr_merged` event tests.
 */
export const GL_PR_MERGED: PullRequest = {
  id: "gl-mr-9",
  platform: "gitlab",
  repo: "mygroup/backend",
  number: 9,
  title: "Add health check endpoint",
  body: "Adds GET /health returning 200 OK with service status.",
  state: "merged",
  isDraft: false,
  author: "frank",
  assignees: [],
  reviewers: [],
  labels: ["ops"],
  sourceBranch: "feat/health-check",
  targetBranch: "main",
  url: "https://gitlab.com/mygroup/backend/-/merge_requests/9",
  createdAt: "2026-03-01T00:00:00Z",
  updatedAt: "2026-03-08T15:00:00Z",
  reviewDecision: "approved",
  commentCount: 2,
  additions: 30,
  deletions: 0,
  changedFiles: 3,
};

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

/**
 * A failed GitLab pipeline on the `main` branch.
 * `main` is in the default {@link MonitorSettings.ciFailureBranches} list,
 * so the classifier should emit a `ci_failure` signal for this event.
 */
export const GL_PIPELINE_FAIL_MAIN: Pipeline = {
  id: "gl-pipeline-201",
  platform: "gitlab",
  repo: "mygroup/backend",
  name: "test-pipeline",
  status: "failed",
  branch: "main",
  commitSha: "deadbeef12345678",
  url: "https://gitlab.com/mygroup/backend/-/pipelines/201",
  startedAt: "2026-03-11T09:00:00Z",
  finishedAt: "2026-03-11T09:03:00Z",
  durationSeconds: 180,
};

/**
 * A failed GitLab pipeline on `release/v2` — a branch not present in the
 * default `ciFailureBranches` list. The classifier should NOT emit a signal.
 */
export const GL_PIPELINE_FAIL_RELEASE: Pipeline = {
  id: "gl-pipeline-202",
  platform: "gitlab",
  repo: "mygroup/backend",
  name: "test-pipeline",
  status: "failed",
  branch: "release/v2",
  commitSha: "cafebabe87654321",
  url: "https://gitlab.com/mygroup/backend/-/pipelines/202",
  startedAt: "2026-03-11T10:00:00Z",
  finishedAt: "2026-03-11T10:02:00Z",
  durationSeconds: 120,
};

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

/**
 * An open GitLab issue that has been assigned to a team member.
 * Used for cross-platform `issue_assigned` event tests.
 */
export const GL_ISSUE: Issue = {
  id: "gl-issue-20",
  platform: "gitlab",
  repo: "mygroup/backend",
  number: 20,
  title: "API returns 500 on empty request body",
  body: "Reproducible with: curl -X POST https://api.example.com/orders.",
  state: "open",
  author: "frank",
  assignees: ["dave"],
  labels: ["bug", "api"],
  url: "https://gitlab.com/mygroup/backend/-/issues/20",
  createdAt: "2026-03-08T00:00:00Z",
  updatedAt: "2026-03-11T00:00:00Z",
  commentCount: 2,
};
