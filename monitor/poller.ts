/**
 * @module monitor/poller
 *
 * Background polling loop for the GitHub/GitLab monitor subsystem.
 *
 * Schedules recurring polls against all monitored GitHub and GitLab repositories.
 * Each cycle:
 * 1. Fetches newly updated PRs/MRs, issues, pipelines, and security alerts.
 * 2. Filters results to events that occurred after the last successful poll.
 * 3. Deduplicates against `seenEventIds` via {@link isEventSeen}.
 * 4. Classifies new events and emits Chalie notifications via
 *    {@link classifyAndNotify}.
 * 5. Persists the updated `lastPollAt` and `seenEventIds` to disk.
 *
 * ## Endpoint filtering strategy
 *
 * | Endpoint                        | Filter mechanism                              |
 * |---------------------------------|-----------------------------------------------|
 * | GitHub PRs                      | Client-side: `updatedAt > lastPollAt`         |
 * | GitHub issues                   | Server-side: `since=lastPollAt`               |
 * | GitHub workflow runs            | Client-side: `finishedAt > lastPollAt`        |
 * | GitHub security alerts          | Deduplication only (no time parameter)        |
 * | GitLab MRs                      | Server-side: `updated_after=lastPollAt`       |
 * | GitLab issues                   | Server-side: `updated_after=lastPollAt`       |
 * | GitLab pipelines                | Server-side: `updated_after=lastPollAt`       |
 *
 * ## Error handling
 *
 * | Error type              | Behaviour                                                    |
 * |-------------------------|--------------------------------------------------------------|
 * | `auth_failed` (401)     | Stop polling that platform permanently; emit reconnect prompt|
 * | `rate_limited` (429)    | Honour `retryAfter`; skip remaining repos this cycle         |
 * | `server_error`/`network`| Log warning; record in-memory lastError; continue           |
 *
 * ## Batch concurrency
 *
 * Repos are polled in batches of at most {@link MAX_CONCURRENT_REPOS} per
 * platform per cycle to stay within API rate limits.
 *
 * ## First run
 *
 * When `lastPollAt` is absent or empty (first run), the effective window is
 * the past 24 hours (`Date.now() - 86_400_000`).
 *
 * @example
 * ```ts
 * import { loadState } from "~/monitor/store.ts";
 * import { startPoller } from "~/monitor/poller.ts";
 *
 * const state = await loadState();
 * startPoller(state);
 * ```
 */

import { ApiError } from "../shared/types.ts";
import type { Issue, Pipeline, PullRequest, SecurityAlert } from "../shared/types.ts";
import { retrieveSecret } from "../sdk-shim/secrets.ts";
import { sendMessage } from "../sdk-shim/ipc.ts";
import {
  listIssues as ghListIssues,
  listPRs as ghListPRs,
  listSecurityAlerts as ghListSecurityAlerts,
  listWorkflowRuns as ghListWorkflowRuns,
} from "../github/mod.ts";
import {
  encodeProjectPath,
  isRateLimitLow as glIsRateLimitLow,
  listIssues as glListIssues,
  listMRs as glListMRs,
  listPipelines as glListPipelines,
} from "../gitlab/mod.ts";
import { classifyAndNotify } from "./classifier.ts";
import type { ClassifierEvent } from "./classifier.ts";
import { addSeenEventId, getState, isEventSeen, saveState } from "./store.ts";
import type { MonitorState } from "./store.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of repository polls to run concurrently per platform per cycle. */
const MAX_CONCURRENT_REPOS = 5;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Platforms that have been permanently stopped due to an authentication failure.
 *
 * Populated by {@link handleAuthFailure}; checked at the start of each cycle
 * and before every batch to prevent further API calls after a 401 response.
 */
const _stoppedPlatforms = new Set<"github" | "gitlab">();

/**
 * In-memory map of the most recent error message per monitored repository.
 *
 * Keys are `"${platform}:${owner/repo}"`. Values are human-readable error
 * descriptions. This map is never persisted — it is intended for diagnostic
 * inspection (e.g. surfacing an amber-dot indicator in the UI for repos in an
 * error state). Cleared for a repo on the next successful poll of that repo.
 */
const _repoLastErrors = new Map<string, string>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the effective last-poll timestamp, falling back to 24 hours ago
 * when `lastPollAt` is empty (i.e. on first run).
 *
 * @param lastPollAt - ISO 8601 string from persisted platform state.
 *   An empty string signals that no previous poll has occurred.
 * @returns ISO 8601 timestamp to use as the polling lower bound.
 */
function effectiveLastPollAt(lastPollAt: string): string {
  return lastPollAt.length > 0
    ? lastPollAt
    : new Date(Date.now() - 86_400_000).toISOString();
}

/**
 * Returns `true` if `timestamp` is strictly after `since`.
 *
 * Both arguments are ISO 8601 strings. String comparison is valid because
 * ISO 8601 timestamps are lexicographically ordered.
 *
 * @param timestamp - The timestamp to test.
 * @param since - The lower bound (exclusive).
 * @returns `true` when `timestamp > since`.
 */
function isAfter(timestamp: string, since: string): boolean {
  return timestamp > since;
}

/**
 * Returns `true` if `body` contains a mention of `@username`.
 *
 * The search is case-sensitive and requires the `@` prefix.
 *
 * @param body - Text to search.
 * @param username - Username to look for (without the `@` prefix).
 * @returns `true` if `@${username}` appears in `body`.
 */
function containsMention(body: string, username: string): boolean {
  return body.includes(`@${username}`);
}

/**
 * Extracts a short excerpt of text surrounding a `@mention` token.
 *
 * Captures up to 40 characters before and 40 characters after the mention.
 *
 * @param body - Full text to excerpt from.
 * @param username - Mentioned username (without `@`).
 * @returns A trimmed excerpt string, or `undefined` if the mention is not found.
 */
function mentionExcerpt(body: string, username: string): string | undefined {
  const idx = body.indexOf(`@${username}`);
  if (idx === -1) return undefined;
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + username.length + 41);
  return body.slice(start, end).trim();
}

/**
 * Constructs a `mention` {@link ClassifierEvent}.
 *
 * Using a dedicated factory avoids conditional-spread union types that can be
 * rejected by `exactOptionalPropertyTypes`.
 *
 * @param platform - Platform the mention originated from.
 * @param repo - `owner/repo` path of the repository.
 * @param itemNumber - Issue or PR number containing the mention.
 * @param author - Username of the person who wrote the mention.
 * @param url - Direct URL to the issue or PR.
 * @param excerpt - Optional short excerpt around the `@mention` token.
 * @returns A fully populated `mention` classifier event.
 */
function makeMentionEvent(
  platform: "github" | "gitlab",
  repo: string,
  itemNumber: number,
  author: string,
  url: string,
  excerpt: string | undefined,
): ClassifierEvent {
  if (excerpt !== undefined) {
    return { type: "mention", platform, repo, itemNumber, author, url, excerpt };
  }
  return { type: "mention", platform, repo, itemNumber, author, url };
}

/**
 * Emits a reconnect-required message for a platform that returned a 401 and
 * marks that platform as permanently stopped for the lifetime of this process.
 *
 * @param platform - The platform whose token was rejected.
 */
function handleAuthFailure(platform: "github" | "gitlab"): void {
  const label = platform === "github" ? "GitHub" : "GitLab";
  _stoppedPlatforms.add(platform);
  sendMessage(
    `${label} authentication failed — your token is invalid or expired. ` +
      `Please reconnect your ${label} account in settings to resume monitoring.`,
    "reconnect_needed",
  );
}

/**
 * Logs a warning for a failed per-repo poll and records the error in the
 * in-memory error map.
 *
 * @param platform - Platform the error occurred on.
 * @param repoFullName - `owner/repo` path of the affected repository.
 * @param message - Human-readable error description.
 */
function recordRepoError(
  platform: "github" | "gitlab",
  repoFullName: string,
  message: string,
): void {
  console.warn(`[monitor/poller] ${platform}/${repoFullName}: ${message}`);
  _repoLastErrors.set(`${platform}:${repoFullName}`, message);
}

/**
 * Splits an `"owner/repo"` path string into its two components.
 *
 * @param fullName - Repository path in `"owner/repo"` format.
 * @returns A `[owner, repo]` tuple, or `null` if the format is invalid
 *   (missing slash, leading slash, or trailing slash).
 */
function parseRepoFullName(fullName: string): [string, string] | null {
  const slashIdx = fullName.indexOf("/");
  if (slashIdx <= 0 || slashIdx >= fullName.length - 1) return null;
  return [fullName.slice(0, slashIdx), fullName.slice(slashIdx + 1)];
}

/**
 * Atomically checks whether an event ID has already been seen and, if not,
 * records it as seen in the module-level cache.
 *
 * Returns `true` when the event is new (i.e. not previously recorded) and
 * the caller should proceed with emitting it. Returns `false` when the event
 * is a duplicate and should be silently dropped.
 *
 * @param platform - Source platform (`"github"` or `"gitlab"`).
 * @param eventId - Opaque, deterministic event identifier string.
 * @returns `true` if the event is new and has now been claimed.
 */
function claimEvent(platform: "github" | "gitlab", eventId: string): boolean {
  if (isEventSeen(platform, eventId)) return false;
  addSeenEventId(platform, eventId);
  return true;
}

// ---------------------------------------------------------------------------
// GitHub event extraction helpers
// ---------------------------------------------------------------------------

/**
 * Derives {@link ClassifierEvent}s from a single GitHub pull request.
 *
 * The PR must have been filtered to `updatedAt > lastPollAt` before this
 * function is called. Emits:
 * - `pr_merged` when `pr.state === "merged"`.
 * - `review_requested` when the PR is open and has one or more requested
 *   reviewers. The event ID encodes the sorted reviewer list, so a new event
 *   is emitted when the reviewer set changes.
 * - `mention` when `@username` appears in the PR body.
 *
 * **Note on `requester`:** The GitHub pull-request list endpoint does not
 * expose who assigned each reviewer. `pr.author` is used as a conservative
 * fallback. Use the Events API for accurate requester attribution.
 *
 * @param pr - Normalised pull request updated after the last poll.
 * @param username - Authenticated GitHub login, for mention detection.
 * @returns Array of new classifier events, possibly empty.
 */
function eventsFromGitHubPR(
  pr: PullRequest,
  username: string,
): ClassifierEvent[] {
  const events: ClassifierEvent[] = [];

  if (pr.state === "merged") {
    if (claimEvent("github", `gh:merged:${pr.id}`)) {
      events.push({ type: "pr_merged", pr });
    }
  } else if (pr.state === "open" && pr.reviewers.length > 0) {
    const sortedReviewers = [...pr.reviewers].sort().join(",");
    if (claimEvent("github", `gh:revreq:${pr.id}:${sortedReviewers}`)) {
      events.push({ type: "review_requested", pr, requester: pr.author });
    }
  }

  if (pr.body !== undefined && containsMention(pr.body, username)) {
    if (claimEvent("github", `gh:mention:pr:${pr.id}`)) {
      events.push(
        makeMentionEvent("github", pr.repo, pr.number, pr.author, pr.url,
          mentionExcerpt(pr.body, username)),
      );
    }
  }

  return events;
}

/**
 * Derives {@link ClassifierEvent}s from a single GitHub issue.
 *
 * The issue must have been fetched with the server-side `since` filter
 * applied. Emits:
 * - `issue_assigned` when the authenticated user appears in `issue.assignees`.
 * - `mention` when `@username` appears in the issue body.
 *
 * @param issue - Normalised issue updated after the last poll.
 * @param username - Authenticated GitHub login.
 * @returns Array of new classifier events, possibly empty.
 */
function eventsFromGitHubIssue(
  issue: Issue,
  username: string,
): ClassifierEvent[] {
  const events: ClassifierEvent[] = [];

  if (issue.assignees.includes(username)) {
    if (claimEvent("github", `gh:assigned:${issue.id}`)) {
      events.push({ type: "issue_assigned", issue, assignee: username });
    }
  }

  if (issue.body !== undefined && containsMention(issue.body, username)) {
    if (claimEvent("github", `gh:mention:issue:${issue.id}`)) {
      events.push(
        makeMentionEvent("github", issue.repo, issue.number, issue.author, issue.url,
          mentionExcerpt(issue.body, username)),
      );
    }
  }

  return events;
}

/**
 * Derives a `ci_failure` {@link ClassifierEvent} from a GitHub workflow run,
 * if it qualifies.
 *
 * A run qualifies when:
 * - `pipeline.status === "failed"`.
 * - The pipeline's finish time (or start time as fallback) is after
 *   `lastPollAt` to avoid re-alerting on pre-existing failures.
 *
 * @param pipeline - Normalised workflow run.
 * @param lastPollAt - ISO 8601 lower bound for event detection.
 * @returns A `ci_failure` event, or `undefined` if the run does not qualify
 *   or was already seen.
 */
function eventFromGitHubPipeline(
  pipeline: Pipeline,
  lastPollAt: string,
): ClassifierEvent | undefined {
  if (pipeline.status !== "failed") return undefined;
  const eventTime = pipeline.finishedAt ?? pipeline.startedAt;
  if (eventTime === undefined || !isAfter(eventTime, lastPollAt)) return undefined;
  if (!claimEvent("github", `gh:cifail:${pipeline.id}`)) return undefined;
  return { type: "ci_failure", pipeline };
}

/**
 * Derives a `security_alert` {@link ClassifierEvent} from a GitHub Dependabot
 * alert.
 *
 * There is no time-based server-side filter on the security alerts endpoint;
 * deduplication is handled entirely by {@link claimEvent}.
 *
 * @param alert - Normalised Dependabot security alert.
 * @returns A `security_alert` event, or `undefined` if already seen.
 */
function eventFromGitHubSecurityAlert(
  alert: SecurityAlert,
): ClassifierEvent | undefined {
  if (!claimEvent("github", `gh:alert:${alert.id}`)) return undefined;
  return { type: "security_alert", alert };
}

// ---------------------------------------------------------------------------
// GitLab event extraction helpers
// ---------------------------------------------------------------------------

/**
 * Derives {@link ClassifierEvent}s from a single GitLab merge request.
 *
 * Server-side `updated_after` filtering is applied before this function is
 * called. Emits:
 * - `pr_merged` when `mr.state === "merged"`.
 * - `review_requested` when the MR is open and has one or more requested
 *   reviewers.
 * - `mention` when `@username` appears in the MR body.
 *
 * **Note on `requester`:** The GitLab MR list endpoint does not expose who
 * assigned a reviewer. `mr.author` is used as a conservative fallback.
 *
 * @param mr - Normalised merge request (as `PullRequest`) updated after the
 *   last poll.
 * @param username - Authenticated GitLab username, for mention detection.
 * @returns Array of new classifier events, possibly empty.
 */
function eventsFromGitLabMR(
  mr: PullRequest,
  username: string,
): ClassifierEvent[] {
  const events: ClassifierEvent[] = [];

  if (mr.state === "merged") {
    if (claimEvent("gitlab", `gl:merged:${mr.id}`)) {
      events.push({ type: "pr_merged", pr: mr });
    }
  } else if (mr.state === "open" && mr.reviewers.length > 0) {
    const sortedReviewers = [...mr.reviewers].sort().join(",");
    if (claimEvent("gitlab", `gl:revreq:${mr.id}:${sortedReviewers}`)) {
      events.push({ type: "review_requested", pr: mr, requester: mr.author });
    }
  }

  if (mr.body !== undefined && containsMention(mr.body, username)) {
    if (claimEvent("gitlab", `gl:mention:mr:${mr.id}`)) {
      events.push(
        makeMentionEvent("gitlab", mr.repo, mr.number, mr.author, mr.url,
          mentionExcerpt(mr.body, username)),
      );
    }
  }

  return events;
}

/**
 * Derives {@link ClassifierEvent}s from a single GitLab issue.
 *
 * Server-side `updated_after` filtering is applied before this function is
 * called. Emits:
 * - `issue_assigned` when the authenticated user appears in `issue.assignees`.
 * - `mention` when `@username` appears in the issue body.
 *
 * @param issue - Normalised issue updated after the last poll.
 * @param username - Authenticated GitLab username.
 * @returns Array of new classifier events, possibly empty.
 */
function eventsFromGitLabIssue(
  issue: Issue,
  username: string,
): ClassifierEvent[] {
  const events: ClassifierEvent[] = [];

  if (issue.assignees.includes(username)) {
    if (claimEvent("gitlab", `gl:assigned:${issue.id}`)) {
      events.push({ type: "issue_assigned", issue, assignee: username });
    }
  }

  if (issue.body !== undefined && containsMention(issue.body, username)) {
    if (claimEvent("gitlab", `gl:mention:issue:${issue.id}`)) {
      events.push(
        makeMentionEvent("gitlab", issue.repo, issue.number, issue.author, issue.url,
          mentionExcerpt(issue.body, username)),
      );
    }
  }

  return events;
}

/**
 * Derives a `ci_failure` {@link ClassifierEvent} from a GitLab pipeline.
 *
 * The pipeline list endpoint is called with `status=failed` and
 * `updated_after=lastPollAt`, so all pipelines passed here are assumed to
 * be failed and recent. Deduplication is handled by {@link claimEvent}.
 *
 * @param pipeline - Normalised GitLab pipeline with `status === "failed"`.
 * @returns A `ci_failure` event, or `undefined` if already seen.
 */
function eventFromGitLabPipeline(pipeline: Pipeline): ClassifierEvent | undefined {
  if (!claimEvent("gitlab", `gl:cifail:${pipeline.id}`)) return undefined;
  return { type: "ci_failure", pipeline };
}

// ---------------------------------------------------------------------------
// Per-repository poll functions
// ---------------------------------------------------------------------------

/**
 * Polls a single GitHub repository for new events.
 *
 * Makes four sequential API calls:
 * 1. **PRs** — `state: "all"`, sorted by `updated` descending; filtered
 *    client-side by `updatedAt > lastPollAt`.
 * 2. **Issues** — filtered server-side with `since=lastPollAt`.
 * 3. **Workflow runs** — filtered client-side by `finishedAt > lastPollAt`.
 * 4. **Security alerts** — all open alerts; deduplicated by event ID only.
 *
 * @param token - GitHub personal access token.
 * @param repoFullName - `owner/repo` path string.
 * @param lastPollAt - Effective last-poll ISO 8601 timestamp.
 * @param username - Authenticated GitHub login for mention/assignment detection.
 * @returns Array of new classifier events found in this repository, possibly
 *   empty.
 * @throws `ApiError` — propagated to the caller for central error handling.
 */
async function pollGitHubRepo(
  token: string,
  repoFullName: string,
  lastPollAt: string,
  username: string,
): Promise<ClassifierEvent[]> {
  const parsed = parseRepoFullName(repoFullName);
  if (parsed === null) {
    console.warn(`[monitor/poller] Skipping malformed GitHub repo name: "${repoFullName}"`);
    return [];
  }
  const [owner, repo] = parsed;
  const events: ClassifierEvent[] = [];

  // 1. Pull Requests — client-side time filter (no `since` param on GitHub PR API).
  const prs = await ghListPRs(token, owner, repo, { state: "all", maxPages: 2 });
  for (const pr of prs) {
    if (!isAfter(pr.updatedAt, lastPollAt)) continue;
    for (const ev of eventsFromGitHubPR(pr, username)) {
      events.push(ev);
    }
  }

  // 2. Issues — server-side `since` filter.
  const issues = await ghListIssues(token, owner, repo, {
    state: "all",
    since: lastPollAt,
    maxPages: 2,
  });
  for (const issue of issues) {
    for (const ev of eventsFromGitHubIssue(issue, username)) {
      events.push(ev);
    }
  }

  // 3. Workflow runs — client-side time filter (no `since` param).
  const pipelines = await ghListWorkflowRuns(token, owner, repo, { maxPages: 2 });
  for (const pipeline of pipelines) {
    const ev = eventFromGitHubPipeline(pipeline, lastPollAt);
    if (ev !== undefined) events.push(ev);
  }

  // 4. Security alerts — deduplication-only filter (no time param on alerts API).
  const alerts = await ghListSecurityAlerts(token, owner, repo, {
    state: "open",
    maxPages: 1,
  });
  for (const alert of alerts) {
    const ev = eventFromGitHubSecurityAlert(alert);
    if (ev !== undefined) events.push(ev);
  }

  return events;
}

/**
 * Polls a single GitLab project for new events.
 *
 * Makes three sequential API calls, all using server-side `updated_after`
 * filtering:
 * 1. **MRs** — `state: "all"`, `updated_after=lastPollAt`.
 * 2. **Issues** — `state: "all"`, `updated_after=lastPollAt`.
 * 3. **Pipelines** — `status=failed`, `updated_after=lastPollAt`.
 *
 * @param token - GitLab personal access token.
 * @param repoFullName - `owner/repo` path (human-readable; URL-encoding applied
 *   internally via {@link encodeProjectPath}).
 * @param lastPollAt - Effective last-poll ISO 8601 timestamp.
 * @param username - Authenticated GitLab username for mention/assignment detection.
 * @returns Array of new classifier events found in this project, possibly empty.
 * @throws `ApiError` — propagated to the caller for central error handling.
 */
async function pollGitLabRepo(
  token: string,
  repoFullName: string,
  lastPollAt: string,
  username: string,
): Promise<ClassifierEvent[]> {
  const projectId = encodeProjectPath(repoFullName);
  const events: ClassifierEvent[] = [];

  // 1. Merge Requests — server-side updated_after filter.
  const mrs = await glListMRs(token, projectId, {
    state: "all",
    updatedAfter: lastPollAt,
    maxPages: 2,
  });
  for (const mr of mrs) {
    for (const ev of eventsFromGitLabMR(mr, username)) {
      events.push(ev);
    }
  }

  // 2. Issues — server-side updated_after filter.
  const issues = await glListIssues(token, projectId, {
    state: "all",
    updatedAfter: lastPollAt,
    maxPages: 2,
  });
  for (const issue of issues) {
    for (const ev of eventsFromGitLabIssue(issue, username)) {
      events.push(ev);
    }
  }

  // 3. Pipelines — server-side updated_after + status=failed filters.
  const pipelines = await glListPipelines(token, projectId, {
    updatedAfter: lastPollAt,
    status: "failed",
    maxPages: 2,
  });
  for (const pipeline of pipelines) {
    const ev = eventFromGitLabPipeline(pipeline);
    if (ev !== undefined) events.push(ev);
  }

  return events;
}

// ---------------------------------------------------------------------------
// Platform poll orchestrators
// ---------------------------------------------------------------------------

/**
 * Control token shared between concurrent repo-poll tasks within a single
 * platform poll cycle.
 *
 * `stopCycle` is set to `true` by any task that encounters a 401 or 429
 * response. The outer batch loop checks this flag before starting each new
 * batch, ensuring no further API calls are made for the remainder of the
 * cycle. In-flight requests within the current batch are allowed to complete.
 */
interface CycleControl {
  /** When `true`, no further repo batches should be started this cycle. */
  stopCycle: boolean;
}

/**
 * Runs one poll cycle for all monitored GitHub repositories.
 *
 * Retrieves the GitHub token via the secrets store, then polls monitored repos
 * in concurrent batches of at most {@link MAX_CONCURRENT_REPOS}. All collected
 * events are dispatched to {@link classifyAndNotify}. On success, updates
 * `state.github.lastPollAt` and flushes state to disk.
 *
 * Error semantics per repo:
 * - `auth_failed` (401): marks GitHub as stopped; sends reconnect prompt.
 * - `rate_limited` (429): sets `control.stopCycle`; logs remaining wait time.
 * - All other errors: logs warning; records error in {@link _repoLastErrors}.
 *
 * @param state - Current monitor state; `state.github.lastPollAt` is mutated
 *   on success.
 */
async function pollGitHubPlatform(state: MonitorState): Promise<void> {
  const platformState = state.github;
  if (platformState === undefined) return;

  const token = await retrieveSecret(platformState.tokenRef);
  if (token === undefined) {
    handleAuthFailure("github");
    return;
  }

  const lastPollAt = effectiveLastPollAt(platformState.lastPollAt);
  const username = platformState.username;
  const repos = [...platformState.monitoredRepos];
  const allEvents: ClassifierEvent[] = [];
  const control: CycleControl = { stopCycle: false };

  for (
    let i = 0;
    i < repos.length && !control.stopCycle && !_stoppedPlatforms.has("github");
    i += MAX_CONCURRENT_REPOS
  ) {
    const batch = repos.slice(i, i + MAX_CONCURRENT_REPOS);

    await Promise.all(
      batch.map(async (repoFullName) => {
        if (control.stopCycle || _stoppedPlatforms.has("github")) return;

        try {
          const repoEvents = await pollGitHubRepo(token, repoFullName, lastPollAt, username);
          _repoLastErrors.delete(`github:${repoFullName}`);
          for (const ev of repoEvents) {
            allEvents.push(ev);
          }
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.code === "auth_failed") {
              handleAuthFailure("github");
              control.stopCycle = true;
            } else if (err.code === "rate_limited") {
              console.warn(
                `[monitor/poller] GitHub rate limited on ${repoFullName}. ` +
                  `Skipping remaining repos this cycle. ` +
                  `Retry after ${err.retryAfter ?? 60}s.`,
              );
              control.stopCycle = true;
            } else {
              recordRepoError("github", repoFullName, err.message);
            }
          } else {
            recordRepoError(
              "github",
              repoFullName,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }),
    );
  }

  if (allEvents.length > 0) {
    await classifyAndNotify({ events: allEvents }, state);
  }

  if (!_stoppedPlatforms.has("github")) {
    platformState.lastPollAt = new Date().toISOString();
    await saveState(state);
  }
}

/**
 * Runs one poll cycle for all monitored GitLab projects.
 *
 * Behaves identically to {@link pollGitHubPlatform} but against the GitLab
 * API. Additionally checks {@link glIsRateLimitLow} before each batch: when
 * the rate limit is running low the remaining repos are deferred until the
 * next cycle rather than risk a 429 response.
 *
 * Error semantics per repo:
 * - `auth_failed` (401): marks GitLab as stopped; sends reconnect prompt.
 * - `rate_limited` (429): sets `control.stopCycle`; logs remaining wait time.
 * - All other errors: logs warning; records error in {@link _repoLastErrors}.
 *
 * @param state - Current monitor state; `state.gitlab.lastPollAt` is mutated
 *   on success.
 */
async function pollGitLabPlatform(state: MonitorState): Promise<void> {
  const platformState = state.gitlab;
  if (platformState === undefined) return;

  const token = await retrieveSecret(platformState.tokenRef);
  if (token === undefined) {
    handleAuthFailure("gitlab");
    return;
  }

  const lastPollAt = effectiveLastPollAt(platformState.lastPollAt);
  const username = platformState.username;
  const repos = [...platformState.monitoredRepos];
  const allEvents: ClassifierEvent[] = [];
  const control: CycleControl = { stopCycle: false };

  for (
    let i = 0;
    i < repos.length && !control.stopCycle && !_stoppedPlatforms.has("gitlab");
    i += MAX_CONCURRENT_REPOS
  ) {
    // Proactively defer remaining repos when the GitLab rate limit is low.
    if (glIsRateLimitLow()) {
      console.warn(
        "[monitor/poller] GitLab rate limit is low — deferring remaining repos to next cycle.",
      );
      break;
    }

    const batch = repos.slice(i, i + MAX_CONCURRENT_REPOS);

    await Promise.all(
      batch.map(async (repoFullName) => {
        if (control.stopCycle || _stoppedPlatforms.has("gitlab")) return;

        try {
          const repoEvents = await pollGitLabRepo(token, repoFullName, lastPollAt, username);
          _repoLastErrors.delete(`gitlab:${repoFullName}`);
          for (const ev of repoEvents) {
            allEvents.push(ev);
          }
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.code === "auth_failed") {
              handleAuthFailure("gitlab");
              control.stopCycle = true;
            } else if (err.code === "rate_limited") {
              console.warn(
                `[monitor/poller] GitLab rate limited on ${repoFullName}. ` +
                  `Skipping remaining repos this cycle. ` +
                  `Retry after ${err.retryAfter ?? 60}s.`,
              );
              control.stopCycle = true;
            } else {
              recordRepoError("gitlab", repoFullName, err.message);
            }
          } else {
            recordRepoError(
              "gitlab",
              repoFullName,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }),
    );
  }

  if (allEvents.length > 0) {
    await classifyAndNotify({ events: allEvents }, state);
  }

  if (!_stoppedPlatforms.has("gitlab")) {
    platformState.lastPollAt = new Date().toISOString();
    await saveState(state);
  }
}

// ---------------------------------------------------------------------------
// Top-level poll cycle
// ---------------------------------------------------------------------------

/**
 * Runs one complete poll cycle across all configured platforms.
 *
 * GitHub and GitLab are polled sequentially (GitHub first) to avoid
 * spreading peak API load across both services simultaneously. Within each
 * platform, up to {@link MAX_CONCURRENT_REPOS} repos are polled concurrently.
 *
 * This function never throws — all errors are caught and handled internally.
 * An outer try/catch guards against unexpected errors to guarantee that the
 * `setInterval` callback never produces an unhandled promise rejection.
 *
 * @param state - Current monitor state snapshot, obtained from
 *   {@link getState} at the start of each interval tick.
 */
async function runPollCycle(state: MonitorState): Promise<void> {
  if (!_stoppedPlatforms.has("github") && state.github !== undefined) {
    await pollGitHubPlatform(state);
  }
  if (!_stoppedPlatforms.has("gitlab") && state.gitlab !== undefined) {
    await pollGitLabPlatform(state);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts the background polling loop, firing an immediate first poll on
 * startup and then scheduling recurring poll cycles at the interval defined
 * in `state.settings.pollIntervalMinutes`.
 *
 * ## Startup behaviour
 *
 * A poll cycle is invoked **immediately** (synchronously dispatched, runs
 * asynchronously) so that users see notifications as soon as the daemon
 * starts rather than having to wait a full `pollIntervalMinutes` interval.
 * Subsequent cycles are then scheduled via `setInterval` to repeat every
 * `pollIntervalMinutes` minutes.
 *
 * ## Interval computation
 *
 * The poll interval is computed once from the initial `state` snapshot. If
 * `pollIntervalMinutes` changes after `startPoller` is called, the process
 * must be restarted to apply the new interval.
 *
 * ## State freshness
 *
 * Within each tick (both the immediate call and each interval tick), the
 * current state is read fresh from the module-level store cache via
 * {@link getState} to pick up any mutations made by capability handlers
 * between ticks (e.g. adding a newly monitored repo).
 *
 * The function returns synchronously after dispatching the immediate poll
 * and registering the interval. The poll loop runs indefinitely until the
 * Deno process exits.
 *
 * @param state - Initial monitor state. Used only to determine the poll
 *   interval; all poll cycles (including the immediate one) use
 *   {@link getState} to obtain the latest state snapshot.
 *
 * @example
 * ```ts
 * import { loadState } from "~/monitor/store.ts";
 * import { startPoller } from "~/monitor/poller.ts";
 *
 * const state = await loadState();
 * startPoller(state); // polls immediately, then every pollIntervalMinutes minutes
 * ```
 */
export function startPoller(state: MonitorState): void {
  const intervalMs = state.settings.pollIntervalMinutes * 60_000;

  // Fire an immediate first poll so users receive notifications on startup
  // rather than waiting for the first interval tick.
  runPollCycle(getState()).catch((err: unknown) => {
    console.error(
      "[monitor/poller] Unexpected error in poll cycle:",
      err instanceof Error ? err.message : String(err),
    );
  });

  setInterval(() => {
    const currentState = getState();
    runPollCycle(currentState).catch((err: unknown) => {
      console.error(
        "[monitor/poller] Unexpected error in poll cycle:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, intervalMs);
}
