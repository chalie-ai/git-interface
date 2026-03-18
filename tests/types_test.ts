/**
 * @module tests/types_test
 *
 * Unit tests for the type-normalisation helpers in `github/client.ts` and
 * `gitlab/client.ts`.
 *
 * ## Testing strategy
 *
 * All normalisation functions are pure (no I/O, no state). Each test
 * constructs a raw API-response fixture object, passes it to the exported
 * normaliser, and asserts the resulting domain-type fields. No network calls
 * are made.
 *
 * ## Coverage
 *
 * | # | Normaliser / behaviour                              | Fixture used                    |
 * |---|-----------------------------------------------------|---------------------------------|
 * | 1 | GitHub draft PR → `isDraft=true, state="open"`     | `RAW_GH_PR_DRAFT`               |
 * | 2 | GitHub merged PR → `state="merged"`                | `RAW_GH_PR_MERGED`              |
 * | 3 | GitHub open non-draft PR → `isDraft=false`         | `RAW_GH_PR_OPEN`                |
 * | 4 | GitHub issue with `pull_request` key → filtered out| `RAW_GH_ISSUE_IS_PR`            |
 * | 5 | GitHub normal issue normalises correctly            | `RAW_GH_ISSUE_NORMAL`           |
 * | 6 | GitHub issue closed state maps to `"closed"`        | `RAW_GH_ISSUE_NORMAL` (mutated) |
 * | 7 | GitHub workflow success → `status="success"`        | `RAW_GH_WORKFLOW_RUN_SUCCESS`   |
 * | 8 | GitHub workflow in-progress → `status="running"`   | `RAW_GH_WORKFLOW_RUN_IN_PROGRESS`|
 * | 9 | GitHub failed workflow → `status="failed"`, `name` fallback | `RAW_GH_WORKFLOW_RUN_FAILED` |
 * |10 | GitLab WIP flag → `isDraft=true, state="open"`     | `RAW_GL_MR_WIP`                 |
 * |11 | GitLab modern `draft=true` → `isDraft=true`        | `RAW_GL_MR_DRAFT_MODERN`        |
 * |12 | GitLab closed MR → `state="closed", isDraft=false` | `RAW_GL_MR_CLOSED`              |
 * |13 | GitLab merged MR → `state="merged"`               | `RAW_GL_MR_MERGED`              |
 * |14 | GitLab `"opened"` state → normalised `"open"`       | `RAW_GL_MR_WIP`                 |
 * |15 | GitLab pipeline running → `status="running"`       | `RAW_GL_PIPELINE_RUNNING`       |
 * |16 | GitLab pipeline success with duration              | `RAW_GL_PIPELINE_SUCCESS`       |
 * |17 | GitLab "canceled" (GitLab spelling) → `"cancelled"`| `RAW_GL_PIPELINE_CANCELED`      |
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  normalizeIssue,
  normalizePipeline as normalizeGHPipeline,
  normalizePR,
} from "../github/client.ts";
import {
  normalizeMR,
  normalizePipeline as normalizeGLPipeline,
} from "../gitlab/client.ts";

import {
  RAW_GH_ISSUE_IS_PR,
  RAW_GH_ISSUE_NORMAL,
  RAW_GH_PR_DRAFT,
  RAW_GH_PR_MERGED,
  RAW_GH_PR_OPEN,
  RAW_GH_WORKFLOW_RUN_FAILED,
  RAW_GH_WORKFLOW_RUN_IN_PROGRESS,
  RAW_GH_WORKFLOW_RUN_SUCCESS,
} from "./fixtures/github_responses.ts";
import {
  RAW_GL_MR_CLOSED,
  RAW_GL_MR_DRAFT_MODERN,
  RAW_GL_MR_MERGED,
  RAW_GL_MR_WIP,
  RAW_GL_PIPELINE_CANCELED,
  RAW_GL_PIPELINE_RUNNING,
  RAW_GL_PIPELINE_SUCCESS,
} from "./fixtures/gitlab_responses.ts";

// ---------------------------------------------------------------------------
// GitHub: Pull Request normalisation
// ---------------------------------------------------------------------------

Deno.test("GitHub normalizePR: draft PR maps to isDraft=true and state=open", () => {
  const pr = normalizePR(RAW_GH_PR_DRAFT, "acme/backend");

  assertEquals(pr.isDraft, true);
  assertEquals(pr.state, "open");
  assertEquals(pr.platform, "github");
  assertEquals(pr.repo, "acme/backend");
  assertEquals(pr.number, 10);
  assertEquals(pr.title, "WIP: Refactor authentication module");
  assertEquals(pr.author, "alice");
  assertEquals(pr.labels, ["wip"]);
  assertEquals(pr.additions, 200);
  assertEquals(pr.deletions, 50);
  assertEquals(pr.changedFiles, 12);
});

Deno.test("GitHub normalizePR: merged PR maps to state=merged regardless of state field", () => {
  // GitHub returns state="closed" on merged PRs; the normaliser must use
  // merged_at !== null to produce state="merged".
  const pr = normalizePR(RAW_GH_PR_MERGED, "acme/backend");

  assertEquals(pr.state, "merged");
  assertEquals(pr.isDraft, false);
  assertEquals(pr.platform, "github");
  assertEquals(pr.number, 9);
  assertEquals(pr.author, "bob");
  assertEquals(pr.assignees, ["carol"]);
  assertEquals(pr.labels, ["bug", "performance"]);
  assertEquals(pr.additions, 45);
  assertEquals(pr.deletions, 120);
  assertEquals(pr.changedFiles, 6);
  assertEquals(pr.mergeableState, "clean");
});

Deno.test("GitHub normalizePR: open non-draft PR maps to isDraft=false and state=open", () => {
  const pr = normalizePR(RAW_GH_PR_OPEN, "acme/backend");

  assertEquals(pr.isDraft, false);
  assertEquals(pr.state, "open");
  assertEquals(pr.reviewers, ["alice", "bob"]);
  assertEquals(pr.commentCount, 3); // comments(2) + review_comments(1)
});

Deno.test("GitHub normalizePR: commentCount is sum of comments and review_comments", () => {
  const pr = normalizePR(RAW_GH_PR_MERGED, "acme/backend");
  // comments(3) + review_comments(5) = 8
  assertEquals(pr.commentCount, 8);
});

Deno.test("GitHub normalizePR: missing additions/deletions/changedFiles default to 0 on list-endpoint shape", () => {
  // Simulate a list-endpoint response (no per-file stats). Optional fields
  // additions, deletions, changed_files are simply omitted from the object.
  const pr = normalizePR(
    {
      id: 100_004,
      number: 20,
      title: "List-endpoint shape PR",
      body: null,
      state: "open",
      draft: false,
      user: { login: "tester" },
      assignees: [] as { login: string }[],
      requested_reviewers: [] as { login: string }[],
      labels: [] as { name: string }[],
      head: { ref: "feat/something", sha: "111aaa222bbb333c" },
      base: { ref: "main", sha: "ccc333ddd444eee5" },
      html_url: "https://github.com/acme/backend/pull/20",
      created_at: "2026-03-18T00:00:00Z",
      updated_at: "2026-03-18T00:00:00Z",
      merged_at: null as string | null,
      comments: 0,
      review_comments: 0,
      // additions, deletions, changed_files intentionally absent (list-endpoint shape)
    },
    "acme/backend",
  );
  assertEquals(pr.additions, 0);
  assertEquals(pr.deletions, 0);
  assertEquals(pr.changedFiles, 0);
});

// ---------------------------------------------------------------------------
// GitHub: Issue normalisation and pull_request filtering
// ---------------------------------------------------------------------------

Deno.test("GitHub issue filtering: items with pull_request key are excluded from results", () => {
  // Reproduce the exact filter pattern used in github/client.ts listIssues().
  const rawItems = [RAW_GH_ISSUE_IS_PR, RAW_GH_ISSUE_NORMAL];
  const trueIssues = rawItems.filter((item) =>
    (item as { pull_request?: unknown }).pull_request === undefined
  );

  // Only the genuine issue should survive the filter.
  assertEquals(trueIssues.length, 1);
  assertEquals(trueIssues[0]?.number, RAW_GH_ISSUE_NORMAL.number);
});

Deno.test("GitHub issue filtering: item with pull_request key does not appear in normalised list", () => {
  const rawItems = [RAW_GH_ISSUE_IS_PR, RAW_GH_ISSUE_NORMAL];
  const normalised = rawItems
    .filter((item) =>
      (item as { pull_request?: unknown }).pull_request === undefined
    )
    .map((item) => normalizeIssue(item, "acme/backend"));

  assertEquals(normalised.length, 1);
  // The surviving item must be the real issue, not the PR-disguised item.
  const [issue] = normalised;
  assertExists(issue);
  assertEquals(issue.number, RAW_GH_ISSUE_NORMAL.number);
  assertEquals(issue.title, RAW_GH_ISSUE_NORMAL.title);
  assertEquals(issue.platform, "github");
});

Deno.test("GitHub normalizeIssue: normal open issue normalises correctly", () => {
  const issue = normalizeIssue(RAW_GH_ISSUE_NORMAL, "acme/backend");

  assertEquals(issue.id, String(RAW_GH_ISSUE_NORMAL.id));
  assertEquals(issue.platform, "github");
  assertEquals(issue.repo, "acme/backend");
  assertEquals(issue.number, 12);
  assertEquals(issue.title, "Database connection pool exhausted under sustained load");
  assertEquals(issue.state, "open");
  assertEquals(issue.author, "carol");
  assertEquals(issue.assignees, ["alice"]);
  assertEquals(issue.labels, ["bug", "performance"]);
  assertEquals(issue.commentCount, 4);
  assertExists(issue.body);
});

Deno.test("GitHub normalizeIssue: closed issue maps state to closed", () => {
  const closedIssue = { ...RAW_GH_ISSUE_NORMAL, state: "closed" };
  const issue = normalizeIssue(closedIssue, "acme/backend");

  assertEquals(issue.state, "closed");
});

Deno.test("GitHub normalizeIssue: null body produces no body field", () => {
  // Construct a fresh object literal so TypeScript can infer the correct
  // structural type compatible with RawGHIssue (body: string | null).
  const issue = normalizeIssue(
    {
      id: 300_001,
      number: 99,
      title: "Issue with no body",
      body: null,
      state: "open",
      user: { login: "tester" },
      assignees: [] as { login: string }[],
      labels: [] as { name: string }[],
      html_url: "https://github.com/acme/backend/issues/99",
      created_at: "2026-03-18T00:00:00Z",
      updated_at: "2026-03-18T00:00:00Z",
      comments: 0,
    },
    "acme/backend",
  );

  assertEquals(issue.body, undefined);
});

// ---------------------------------------------------------------------------
// GitHub: Pipeline (workflow run) normalisation
// ---------------------------------------------------------------------------

Deno.test("GitHub normalizePipeline: completed success run maps to status=success", () => {
  const pipeline = normalizeGHPipeline(RAW_GH_WORKFLOW_RUN_SUCCESS, "acme/backend");

  assertEquals(pipeline.status, "success");
  assertEquals(pipeline.platform, "github");
  assertEquals(pipeline.repo, "acme/backend");
  assertEquals(pipeline.name, "CI / integration-tests");
  assertEquals(pipeline.branch, "main");
  assertEquals(pipeline.commitSha, RAW_GH_WORKFLOW_RUN_SUCCESS.head_sha);
  assertExists(pipeline.startedAt);
  assertExists(pipeline.finishedAt);
  assertExists(pipeline.durationSeconds);
  // 08:00 to 08:12 = 720 seconds
  assertEquals(pipeline.durationSeconds, 720);
});

Deno.test("GitHub normalizePipeline: in-progress run maps to status=running", () => {
  const pipeline = normalizeGHPipeline(RAW_GH_WORKFLOW_RUN_IN_PROGRESS, "acme/backend");

  assertEquals(pipeline.status, "running");
  assertEquals(pipeline.branch, "feature/auth-refactor");
  // Not completed → no finishedAt, no durationSeconds
  assertEquals(pipeline.finishedAt, undefined);
  assertEquals(pipeline.durationSeconds, undefined);
});

Deno.test("GitHub normalizePipeline: failed run maps to status=failed and null name falls back", () => {
  const pipeline = normalizeGHPipeline(RAW_GH_WORKFLOW_RUN_FAILED, "acme/backend");

  assertEquals(pipeline.status, "failed");
  // null name falls back to "Workflow Run"
  assertEquals(pipeline.name, "Workflow Run");
});

// ---------------------------------------------------------------------------
// GitLab: Merge Request normalisation
// ---------------------------------------------------------------------------

Deno.test("GitLab normalizeMR: work_in_progress=true maps to isDraft=true", () => {
  // Core acceptance criterion: legacy WIP flag must be honoured.
  const pr = normalizeMR(RAW_GL_MR_WIP, "acme/api");

  assertEquals(pr.isDraft, true);
  assertEquals(pr.platform, "gitlab");
  assertEquals(pr.repo, "acme/api");
  assertEquals(pr.number, 20);
  assertEquals(pr.title, "WIP: Implement Redis caching layer");
});

Deno.test("GitLab normalizeMR: work_in_progress=true, draft=false → state=open", () => {
  const pr = normalizeMR(RAW_GL_MR_WIP, "acme/api");

  // GitLab "opened" → normalised "open"
  assertEquals(pr.state, "open");
  assertEquals(pr.isDraft, true);
});

Deno.test("GitLab normalizeMR: modern draft=true maps to isDraft=true", () => {
  const pr = normalizeMR(RAW_GL_MR_DRAFT_MODERN, "acme/api");

  assertEquals(pr.isDraft, true);
  assertEquals(pr.state, "open");
  assertEquals(pr.author, "frank");
  assertEquals(pr.assignees, ["grace"]);
  assertEquals(pr.reviewers, ["henry"]);
  assertEquals(pr.labels, ["backend", "graphql"]);
});

Deno.test("GitLab normalizeMR: both draft=false and work_in_progress=false → isDraft=false", () => {
  const pr = normalizeMR(RAW_GL_MR_CLOSED, "acme/api");

  assertEquals(pr.isDraft, false);
});

Deno.test("GitLab normalizeMR: closed MR maps to state=closed", () => {
  const pr = normalizeMR(RAW_GL_MR_CLOSED, "acme/api");

  assertEquals(pr.state, "closed");
  assertEquals(pr.isDraft, false);
  assertEquals(pr.platform, "gitlab");
  assertEquals(pr.number, 19);
});

Deno.test("GitLab normalizeMR: merged MR maps to state=merged", () => {
  const pr = normalizeMR(RAW_GL_MR_MERGED, "acme/api");

  assertEquals(pr.state, "merged");
  assertEquals(pr.isDraft, false);
  assertEquals(pr.additions, 410);
  assertEquals(pr.deletions, 95);
  assertEquals(pr.changedFiles, 22);
});

Deno.test("GitLab normalizeMR: changes_count string is parsed to changedFiles number", () => {
  // RAW_GL_MR_WIP has changes_count as the string "8"
  const pr = normalizeMR(RAW_GL_MR_WIP, "acme/api");

  assertEquals(pr.changedFiles, 8);
});

Deno.test("GitLab normalizeMR: null changes_count produces changedFiles=0", () => {
  const pr = normalizeMR(RAW_GL_MR_DRAFT_MODERN, "acme/api");

  // changes_count is null for RAW_GL_MR_DRAFT_MODERN
  assertEquals(pr.changedFiles, 0);
});

Deno.test("GitLab normalizeMR: null description produces no body field", () => {
  const pr = normalizeMR(RAW_GL_MR_DRAFT_MODERN, "acme/api");

  // description is null for RAW_GL_MR_DRAFT_MODERN
  assertEquals(pr.body, undefined);
});

// ---------------------------------------------------------------------------
// GitLab: Pipeline normalisation
// ---------------------------------------------------------------------------

Deno.test("GitLab normalizePipeline: running pipeline maps to status=running", () => {
  const pipeline = normalizeGLPipeline(RAW_GL_PIPELINE_RUNNING, "acme/api");

  assertEquals(pipeline.status, "running");
  assertEquals(pipeline.platform, "gitlab");
  assertEquals(pipeline.repo, "acme/api");
  assertEquals(pipeline.branch, "main");
  assertEquals(pipeline.commitSha, RAW_GL_PIPELINE_RUNNING.sha);
  assertExists(pipeline.startedAt);
  // Not finished → no finishedAt or durationSeconds
  assertEquals(pipeline.finishedAt, undefined);
  assertEquals(pipeline.durationSeconds, undefined);
});

Deno.test("GitLab normalizePipeline: success pipeline with duration maps durationSeconds", () => {
  const pipeline = normalizeGLPipeline(RAW_GL_PIPELINE_SUCCESS, "acme/api");

  assertEquals(pipeline.status, "success");
  assertEquals(pipeline.durationSeconds, 427);
  assertExists(pipeline.startedAt);
  assertExists(pipeline.finishedAt);
  assertEquals(pipeline.name, "Pipeline for merge request");
});

Deno.test('GitLab normalizePipeline: "canceled" status (GitLab spelling) maps to "cancelled"', () => {
  // GitLab spells it "canceled"; normaliser must produce "cancelled".
  const pipeline = normalizeGLPipeline(RAW_GL_PIPELINE_CANCELED, "acme/api");

  assertEquals(pipeline.status, "cancelled");
  assertEquals(pipeline.durationSeconds, 75);
});

Deno.test("GitLab normalizePipeline: pipeline without name falls back to generated name", () => {
  // RAW_GL_PIPELINE_RUNNING has no name field → fallback "Pipeline #<id>"
  const pipeline = normalizeGLPipeline(RAW_GL_PIPELINE_RUNNING, "acme/api");

  assertEquals(pipeline.name, `Pipeline #${RAW_GL_PIPELINE_RUNNING.id}`);
});
