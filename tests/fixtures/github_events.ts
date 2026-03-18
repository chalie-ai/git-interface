/**
 * @module tests/fixtures/github_events
 *
 * Synthetic GitHub event fixtures for use in classifier unit tests.
 * All objects are inline constants — no network calls are made.
 *
 * Types are drawn from {@link shared/types.ts}. The shapes mirror real
 * GitHub API responses that have been normalised through the GitHub client.
 */

import type { Issue, Pipeline, PullRequest, SecurityAlert } from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// Pull Requests
// ---------------------------------------------------------------------------

/**
 * An open, non-draft GitHub pull request with diff stats and a requested
 * reviewer. Used for `review_requested` event tests.
 */
export const GH_PR: PullRequest = {
  id: "gh-pr-42",
  platform: "github",
  repo: "acme/frontend",
  number: 42,
  title: "Add OAuth login",
  body: "Implements the Google OAuth login flow.",
  state: "open",
  isDraft: false,
  author: "bob",
  assignees: [],
  reviewers: ["alice"],
  labels: ["feature"],
  sourceBranch: "feature/oauth",
  targetBranch: "main",
  url: "https://github.com/acme/frontend/pull/42",
  createdAt: "2026-03-01T00:00:00Z",
  updatedAt: "2026-03-10T00:00:00Z",
  ciStatus: "success",
  commentCount: 3,
  additions: 120,
  deletions: 15,
  changedFiles: 8,
};

/**
 * A merged GitHub pull request. Used for `pr_merged` event tests.
 */
export const GH_PR_MERGED: PullRequest = {
  id: "gh-pr-38",
  platform: "github",
  repo: "acme/frontend",
  number: 38,
  title: "Fix header layout",
  body: "Resolves #30 — corrects the flex-wrap setting on mobile viewports.",
  state: "merged",
  isDraft: false,
  author: "carol",
  assignees: [],
  reviewers: [],
  labels: ["bug", "ui"],
  sourceBranch: "fix/header-layout",
  targetBranch: "main",
  url: "https://github.com/acme/frontend/pull/38",
  createdAt: "2026-03-05T00:00:00Z",
  updatedAt: "2026-03-09T12:00:00Z",
  ciStatus: "success",
  reviewDecision: "approved",
  commentCount: 1,
  additions: 8,
  deletions: 3,
  changedFiles: 2,
};

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

/**
 * A failed GitHub Actions workflow run on the `main` branch.
 * `main` is in the default {@link MonitorSettings.ciFailureBranches} list,
 * so this event should trigger a `ci_failure` signal.
 */
export const GH_PIPELINE_FAIL_MAIN: Pipeline = {
  id: "gh-run-1001",
  platform: "github",
  repo: "acme/frontend",
  name: "CI / test",
  status: "failed",
  branch: "main",
  commitSha: "abc123def456abc1",
  url: "https://github.com/acme/frontend/actions/runs/1001",
  startedAt: "2026-03-10T10:00:00Z",
  finishedAt: "2026-03-10T10:05:00Z",
  durationSeconds: 300,
};

/**
 * A failed GitHub Actions workflow run on `feature/oauth`.
 * This branch is NOT in `ciFailureBranches`, so the classifier should
 * NOT emit any signal for this event.
 */
export const GH_PIPELINE_FAIL_FEATURE: Pipeline = {
  id: "gh-run-1002",
  platform: "github",
  repo: "acme/frontend",
  name: "CI / test",
  status: "failed",
  branch: "feature/oauth",
  commitSha: "deadbeef00000001",
  url: "https://github.com/acme/frontend/actions/runs/1002",
  startedAt: "2026-03-10T11:00:00Z",
  finishedAt: "2026-03-10T11:04:20Z",
  durationSeconds: 260,
};

// ---------------------------------------------------------------------------
// Security Alert
// ---------------------------------------------------------------------------

/**
 * A critical Dependabot vulnerability alert for the `lodash` package with a
 * known fix version available. Used for `security_alert` event tests.
 */
export const GH_SECURITY_ALERT: SecurityAlert = {
  id: "gh-alert-77",
  platform: "github",
  repo: "acme/frontend",
  title: "Critical vulnerability in lodash (CVE-2021-23337)",
  severity: "critical",
  packageName: "lodash",
  vulnerableRange: "< 4.17.21",
  fixedVersion: "4.17.21",
  url: "https://github.com/acme/frontend/security/dependabot/77",
  createdAt: "2026-03-10T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

/**
 * An open GitHub issue that has been assigned. Used for `issue_assigned`
 * event tests.
 */
export const GH_ISSUE: Issue = {
  id: "gh-issue-5",
  platform: "github",
  repo: "acme/frontend",
  number: 5,
  title: "Button alignment broken on mobile",
  body: "Steps to reproduce: navigate to /settings on a 375px viewport.",
  state: "open",
  author: "carol",
  assignees: ["alice"],
  labels: ["bug"],
  url: "https://github.com/acme/frontend/issues/5",
  createdAt: "2026-03-05T00:00:00Z",
  updatedAt: "2026-03-10T00:00:00Z",
  commentCount: 1,
};
