/**
 * @module monitor/classifier
 *
 * Event classification and notification dispatch for the background monitor.
 *
 * The classifier receives a batch of typed events (produced by the poller
 * after fetching from GitHub / GitLab) together with the current
 * {@link MonitorState} settings, and routes each event to the appropriate
 * Chalie IPC primitive:
 *
 * | Event                    | Urgency | Primitive     | Energy  |
 * |--------------------------|---------|---------------|---------|
 * | Review requested         | High    | `sendMessage` | —       |
 * | CI failure (key branch)  | High    | `sendSignal`  | `high`  |
 * | Security alert           | High    | `sendMessage` | —       |
 * | @mention in comment/PR   | Medium  | `sendSignal`  | `medium`|
 * | PR merged                | Low     | `sendSignal`  | `low`   |
 * | Issue assigned           | Medium  | `sendSignal`  | `medium`|
 *
 * `sendMessage` is used for events that must always surface to the user
 * immediately. `sendSignal` is used for events where Chalie decides whether
 * to surface based on the activation energy and current context.
 *
 * ## Guard flags
 *
 * Four event types have a corresponding `notifyOn*` boolean in
 * {@link MonitorSettings}. When the flag is `false` the event is silently
 * skipped. PR-merged and issue-assigned signals are always emitted because
 * they use low/medium energy and Chalie's context engine is responsible for
 * deciding whether to surface them.
 *
 * @example
 * ```ts
 * import { classifyAndNotify } from "~/monitor/classifier.ts";
 * import { loadState } from "~/monitor/store.ts";
 *
 * const state = await loadState();
 * await classifyAndNotify({ events: newEvents }, state);
 * ```
 */

import { sendMessage, sendSignal } from "../sdk-shim/ipc.ts";
import type { Platform } from "../shared/types.ts";
import type { Issue, Pipeline, PullRequest, SecurityAlert } from "../shared/types.ts";
import type { MonitorState } from "./store.ts";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * A review has been requested on a pull/merge request.
 *
 * The `requester` field holds the username of the person who assigned the
 * review, which may differ from the PR author.
 */
export interface ReviewRequestEvent {
  /** Discriminant for this event variant. */
  type: "review_requested";
  /** The pull/merge request for which a review was requested. */
  pr: PullRequest;
  /** Username of the person who requested the review. */
  requester: string;
}

/**
 * A CI/CD pipeline run finished with a failure status.
 *
 * The classifier checks `pipeline.branch` against
 * `settings.ciFailureBranches` before emitting a notification, so only
 * failures on key branches (default: `["main", "master"]`) are surfaced.
 */
export interface CIFailureEvent {
  /** Discriminant for this event variant. */
  type: "ci_failure";
  /** The failed pipeline run. */
  pipeline: Pipeline;
}

/**
 * A new dependency or code-scanning security alert has been raised.
 */
export interface SecurityAlertEvent {
  /** Discriminant for this event variant. */
  type: "security_alert";
  /** The security alert payload. */
  alert: SecurityAlert;
}

/**
 * The authenticated user was @mentioned in a comment or PR/issue body.
 *
 * The fields carry the minimum context needed to compose a notification —
 * the poller is responsible for detecting the mention and constructing this
 * event from either a {@link Comment} or a {@link PullRequest} body scan.
 */
export interface MentionEvent {
  /** Discriminant for this event variant. */
  type: "mention";
  /** Platform the mention originated from. */
  platform: Platform;
  /** `owner/repo` path of the containing repository. */
  repo: string;
  /** Sequential number of the issue or PR containing the mention. */
  itemNumber: number;
  /** Username of the person who wrote the comment/body containing the mention. */
  author: string;
  /** Direct URL to the comment or PR. */
  url: string;
  /**
   * Short excerpt of the text surrounding the mention, for context.
   * Optional — may not be available for PR body mentions.
   */
  excerpt?: string;
}

/**
 * A pull/merge request was successfully merged.
 */
export interface PRMergedEvent {
  /** Discriminant for this event variant. */
  type: "pr_merged";
  /** The merged pull/merge request. */
  pr: PullRequest;
}

/**
 * An issue was assigned to the authenticated user.
 *
 * `assignee` is the username that the issue was assigned to (typically the
 * authenticated user, but may differ when monitoring shared accounts).
 */
export interface IssueAssignedEvent {
  /** Discriminant for this event variant. */
  type: "issue_assigned";
  /** The issue that was assigned. */
  issue: Issue;
  /** Username the issue was assigned to. */
  assignee: string;
}

/**
 * Discriminated union of all event types the classifier can handle.
 *
 * Each variant carries the minimal payload required to compose a
 * human-readable notification message without further API calls.
 */
export type ClassifierEvent =
  | ReviewRequestEvent
  | CIFailureEvent
  | SecurityAlertEvent
  | MentionEvent
  | PRMergedEvent
  | IssueAssignedEvent;

/**
 * Input payload for {@link classifyAndNotify}.
 *
 * Carries the batch of events fetched during a single poll cycle. The
 * events may originate from multiple platforms and repositories.
 */
export interface ClassifierInput {
  /**
   * Batch of newly fetched events to classify.
   *
   * Events that were already seen in a previous cycle should be filtered
   * out by the poller before constructing this input; the classifier does
   * not perform deduplication.
   */
  events: ClassifierEvent[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable platform label for use in notification messages.
 *
 * @param platform - The source platform identifier.
 * @returns `"GitHub"` or `"GitLab"`.
 */
function platformLabel(platform: Platform): string {
  return platform === "github" ? "GitHub" : "GitLab";
}

// ---------------------------------------------------------------------------
// Handlers (one per event variant)
// ---------------------------------------------------------------------------

/**
 * Handles a `review_requested` event by emitting a high-urgency message.
 *
 * Includes PR title, repository, requester username, diff statistics
 * (additions, deletions, files changed), and a direct URL. Only emits
 * when `settings.notifyOnReviewRequest` is `true`.
 *
 * @param event - The review-request event to handle.
 * @param notifyOn - The value of `settings.notifyOnReviewRequest`.
 */
function handleReviewRequested(event: ReviewRequestEvent, notifyOn: boolean): void {
  if (!notifyOn) return;

  const { pr, requester } = event;
  const label = platformLabel(pr.platform);

  sendMessage(
    `[${label}] Review requested on "${pr.title}" in ${pr.repo} by ${requester}. ` +
      `${pr.additions}+ ${pr.deletions}- across ${pr.changedFiles} files. ` +
      `${pr.url}`,
    "review_request",
  );
}

/**
 * Handles a `ci_failure` event by emitting a high-energy signal.
 *
 * Emits only when:
 * - `settings.notifyOnCIFailure` is `true`.
 * - `pipeline.branch` is present in `settings.ciFailureBranches`.
 *
 * @param event - The CI-failure event to handle.
 * @param notifyOn - The value of `settings.notifyOnCIFailure`.
 * @param ciFailureBranches - The branch allowlist from settings.
 */
function handleCIFailure(
  event: CIFailureEvent,
  notifyOn: boolean,
  ciFailureBranches: string[],
): void {
  if (!notifyOn) return;

  const { pipeline } = event;
  if (!ciFailureBranches.includes(pipeline.branch)) return;

  const label = platformLabel(pipeline.platform);

  sendSignal(
    "ci_failure",
    `[${label}] CI failed on "${pipeline.branch}" in ${pipeline.repo}: ${pipeline.name}. ${pipeline.url}`,
    "high",
    {
      repo: pipeline.repo,
      platform: pipeline.platform,
      branch: pipeline.branch,
      pipelineName: pipeline.name,
      pipelineId: pipeline.id,
      url: pipeline.url,
    },
  );
}

/**
 * Handles a `security_alert` event by emitting a high-urgency message.
 *
 * The message includes the affected package name, severity level,
 * vulnerability title (which typically contains the CVE identifier),
 * and fix version when available. Only emits when
 * `settings.notifyOnSecurityAlert` is `true`.
 *
 * @param event - The security-alert event to handle.
 * @param notifyOn - The value of `settings.notifyOnSecurityAlert`.
 */
function handleSecurityAlert(event: SecurityAlertEvent, notifyOn: boolean): void {
  if (!notifyOn) return;

  const { alert } = event;
  const label = platformLabel(alert.platform);
  const fixInfo = alert.fixedVersion !== undefined
    ? ` Fix available: ${alert.fixedVersion}.`
    : " No fix available yet.";

  sendMessage(
    `[${label}] Security alert in ${alert.repo}: ${alert.packageName} (${alert.severity}) — ${alert.title}.${fixInfo} ${alert.url}`,
    "security_alert",
  );
}

/**
 * Handles a `mention` event by emitting a medium-energy signal.
 *
 * Emits only when `settings.notifyOnMention` is `true`. Includes the
 * repository, issue/PR number, and the author of the mentioning comment.
 *
 * @param event - The mention event to handle.
 * @param notifyOn - The value of `settings.notifyOnMention`.
 */
function handleMention(event: MentionEvent, notifyOn: boolean): void {
  if (!notifyOn) return;

  const label = platformLabel(event.platform);

  sendSignal(
    "mention",
    `[${label}] You were mentioned in ${event.repo}#${event.itemNumber} by ${event.author}. ${event.url}`,
    "medium",
    {
      repo: event.repo,
      platform: event.platform,
      itemNumber: event.itemNumber,
      author: event.author,
      url: event.url,
      ...(event.excerpt !== undefined ? { excerpt: event.excerpt } : {}),
    },
  );
}

/**
 * Handles a `pr_merged` event by emitting a low-energy signal.
 *
 * This event type has no `notifyOn*` guard flag because it uses low
 * activation energy — Chalie's context engine decides whether to surface
 * it based on the current conversation. The signal is always emitted.
 *
 * @param event - The PR-merged event to handle.
 */
function handlePRMerged(event: PRMergedEvent): void {
  const { pr } = event;
  const label = platformLabel(pr.platform);

  sendSignal(
    "pr_merged",
    `[${label}] PR merged: "${pr.title}" in ${pr.repo} by ${pr.author}. ${pr.url}`,
    "low",
    {
      repo: pr.repo,
      platform: pr.platform,
      prNumber: pr.number,
      author: pr.author,
      url: pr.url,
    },
  );
}

/**
 * Handles an `issue_assigned` event by emitting a medium-energy signal.
 *
 * This event type has no `notifyOn*` guard flag because it uses medium
 * activation energy — Chalie's context engine decides whether to surface
 * it. The signal is always emitted.
 *
 * @param event - The issue-assigned event to handle.
 */
function handleIssueAssigned(event: IssueAssignedEvent): void {
  const { issue, assignee } = event;
  const label = platformLabel(issue.platform);

  sendSignal(
    "issue_assigned",
    `[${label}] Issue assigned to ${assignee}: "${issue.title}" in ${issue.repo}. ${issue.url}`,
    "medium",
    {
      repo: issue.repo,
      platform: issue.platform,
      issueNumber: issue.number,
      assignee,
      url: issue.url,
    },
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classifies a batch of newly fetched events and dispatches notifications
 * via the Chalie IPC primitives (`sendMessage` / `sendSignal`).
 *
 * Each event in `input.events` is dispatched to a typed handler. Handlers
 * consult `state.settings` to determine whether the notification type is
 * enabled and, for CI failures, whether the branch qualifies.
 *
 * All current handlers are synchronous. The return type is `void` rather
 * than `Promise<void>` because no async I/O is performed; callers that
 * already `await` this function continue to work unchanged since `await`
 * on a non-Promise value resolves immediately.
 *
 * @param input - Batch of classified events to process.
 * @param state - Current monitor state; the `settings` field controls which
 *   notification types are active and which CI branches trigger alerts.
 *
 * @example
 * ```ts
 * classifyAndNotify(
 *   {
 *     events: [
 *       { type: "review_requested", pr, requester: "alice" },
 *       { type: "ci_failure", pipeline },
 *     ],
 *   },
 *   state,
 * );
 * ```
 */
export function classifyAndNotify(
  input: ClassifierInput,
  state: MonitorState,
): void {
  const { settings } = state;

  for (const event of input.events) {
    switch (event.type) {
      case "review_requested":
        handleReviewRequested(event, settings.notifyOnReviewRequest);
        break;

      case "ci_failure":
        handleCIFailure(event, settings.notifyOnCIFailure, settings.ciFailureBranches);
        break;

      case "security_alert":
        handleSecurityAlert(event, settings.notifyOnSecurityAlert);
        break;

      case "mention":
        handleMention(event, settings.notifyOnMention);
        break;

      case "pr_merged":
        handlePRMerged(event);
        break;

      case "issue_assigned":
        handleIssueAssigned(event);
        break;
    }
  }
}
