/**
 * @module ui/dashboard
 *
 * Main monitoring dashboard renderer for the Chalie Git Interface tool.
 *
 * Renders HTML fragments using semantic markup with `data-radiant-*`
 * attribute hooks compatible with Chalie's Radiant design system. All
 * styling is delegated to the host shell via the attribute hooks; no
 * external CSS imports are used.
 *
 * ## Exports
 *
 * | Function | Description |
 * |---|---|
 * | {@link renderDashboard} | Full dashboard with platform cards, event feed, and settings. |
 * | {@link renderEmptyState} | Prompt shown when no platforms have been configured. |
 *
 * ## Connection status indicators
 *
 * Each configured platform displays a coloured status dot:
 *
 * | Indicator | Condition |
 * |---|---|
 * | Green (`connected`) | Platform configured; last poll completed with no errors. |
 * | Amber (`degraded`) | Platform configured; `lastError` is set on the platform state. |
 * | Red (`auth_failed`) | Platform configured; `authFailed` is `true` (token rejected). |
 *
 * ## DashboardEvent
 *
 * The {@link DashboardEvent} type represents a single displayable event in
 * the recent-events feed. Callers (typically the poller or capability
 * handlers) construct these from {@link ClassifierEvent} instances and pass
 * them as the `recentEvents` argument to {@link renderDashboard}.
 *
 * @example
 * ```ts
 * import { renderDashboard } from "~/ui/dashboard.ts";
 * import { loadState } from "~/monitor/store.ts";
 *
 * const state = await loadState();
 * const html = renderDashboard(state, []);
 * ```
 */

import type { Platform } from "~/shared/mod.ts";
import type { GitHubPlatformState, GitLabPlatformState, MonitorState } from "~/monitor/store.ts";

// ---------------------------------------------------------------------------
// DashboardEvent — public type
// ---------------------------------------------------------------------------

/**
 * Discriminated category of a displayable dashboard event.
 *
 * Mirrors the classifier event types from `monitor/classifier.ts` so that
 * callers can derive `DashboardEvent` objects from `ClassifierEvent` values
 * without a direct import dependency.
 */
export type DashboardEventKind =
  | "review_requested"
  | "ci_failure"
  | "security_alert"
  | "pr_merged"
  | "mention"
  | "issue_assigned";

/**
 * A single event entry shown in the dashboard recent-events feed.
 *
 * Callers construct these from classifier or poller output and pass them to
 * {@link renderDashboard} as the `recentEvents` argument.
 *
 * @example
 * ```ts
 * const event: DashboardEvent = {
 *   kind: "ci_failure",
 *   platform: "github",
 *   repo: "owner/repo",
 *   title: "CI failed on main — build.yml",
 *   url: "https://github.com/owner/repo/actions/runs/12345",
 *   actor: "ci-bot",
 *   occurredAt: new Date().toISOString(),
 * };
 * ```
 */
export interface DashboardEvent {
  /** Category of the event, used to select the icon and label. */
  kind: DashboardEventKind;
  /** Platform the event originated from. */
  platform: Platform;
  /** `owner/repo` path of the repository the event belongs to. */
  repo: string;
  /** Short human-readable description of the event. */
  title: string;
  /** Deep link URL to the event on the platform website. */
  url: string;
  /** Username of the user who triggered the event, if applicable. */
  actor?: string;
  /** ISO 8601 timestamp when the event occurred. */
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Computed connection status for a single platform.
 *
 * - `"connected"` — platform configured and last poll had no errors.
 * - `"degraded"` — platform configured but `lastError` is set.
 * - `"auth_failed"` — platform configured but token was rejected (401).
 * - `"disconnected"` — platform is not configured.
 */
type ConnectionStatus = "connected" | "degraded" | "auth_failed" | "disconnected";

// ---------------------------------------------------------------------------
// HTML utilities
// ---------------------------------------------------------------------------

/**
 * Escapes a plain-text string for safe insertion into HTML content or
 * attribute values.
 *
 * Replaces the five HTML-special characters (`&`, `<`, `>`, `"`, `'`) with
 * their named entity equivalents. Must be called on every piece of
 * user-supplied or API-derived data before HTML embedding to prevent XSS.
 *
 * @param str - The raw string to escape.
 * @returns The HTML-escaped string.
 */
function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Formats an ISO 8601 timestamp as a human-readable relative time string
 * (e.g. `"2 minutes ago"`, `"3 hours ago"`).
 *
 * Returns `"just now"` for timestamps within the last 60 seconds.
 * Returns `"unknown"` when the input is empty, `null`, or not parseable
 * as a valid date.
 *
 * @param isoDate - ISO 8601 date-time string to format.
 * @returns A human-readable relative time string.
 */
function relativeTime(isoDate: string): string {
  if (!isoDate) return "unknown";

  const ts = Date.parse(isoDate);
  if (Number.isNaN(ts)) return "unknown";

  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "just now"; // clock skew guard

  const secs = Math.floor(diffMs / 1_000);
  if (secs < 60) return "just now";

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Returns the connection status for a platform given its persisted state
 * object.
 *
 * Precedence: `authFailed` → `lastError` → `connected`.
 *
 * @param platformState - The `GitHubPlatformState` or `GitLabPlatformState`
 *   read from `MonitorState`.
 * @returns The computed {@link ConnectionStatus} for use in the dashboard UI.
 */
function computeConnectionStatus(
  platformState: GitHubPlatformState | GitLabPlatformState,
): ConnectionStatus {
  if (platformState.authFailed === true) return "auth_failed";
  if (platformState.lastError !== undefined && platformState.lastError.length > 0) {
    return "degraded";
  }
  return "connected";
}

/**
 * Renders an inline SVG status dot with an accessible label for the given
 * connection status.
 *
 * The dot's colour is controlled by the `data-radiant-status` attribute so
 * that the Radiant shell can apply theming without overriding inline styles.
 *
 * @param status - The connection status to visualise.
 * @returns An HTML string containing a `<span>` status dot element.
 */
function renderStatusDot(status: ConnectionStatus): string {
  const labels: Record<ConnectionStatus, string> = {
    connected: "Connected",
    degraded: "Degraded — last poll had errors",
    auth_failed: "Authentication failed — reconnect required",
    disconnected: "Disconnected",
  };
  const label = labels[status];
  return `<span
    data-radiant-status-dot
    data-radiant-status="${escHtml(status)}"
    role="img"
    aria-label="${escHtml(label)}"
    title="${escHtml(label)}"></span>`;
}

/**
 * Maps a {@link DashboardEventKind} to a short human-readable label string.
 *
 * @param kind - The event kind to label.
 * @returns A capitalised label string (e.g. `"Review requested"`).
 */
function eventKindLabel(kind: DashboardEventKind): string {
  const labels: Record<DashboardEventKind, string> = {
    review_requested: "Review requested",
    ci_failure: "CI failure",
    security_alert: "Security alert",
    pr_merged: "PR merged",
    mention: "Mention",
    issue_assigned: "Issue assigned",
  };
  return labels[kind];
}

// ---------------------------------------------------------------------------
// Platform card renderer
// ---------------------------------------------------------------------------

/**
 * Renders a single platform connection card showing status, username,
 * monitored repositories, and last-polled timestamp.
 *
 * @param platform - Which platform this card represents.
 * @param platformState - The persisted state for the platform.
 * @returns An HTML string for the platform card section.
 */
function renderPlatformCard(
  platform: Platform,
  platformState: GitHubPlatformState | GitLabPlatformState,
): string {
  const platformLabel = platform === "github" ? "GitHub" : "GitLab";
  const status = computeConnectionStatus(platformState);
  const statusDot = renderStatusDot(status);

  const lastPolled = platformState.lastPollAt.length > 0
    ? `<time datetime="${escHtml(platformState.lastPollAt)}" data-radiant-meta>
          Last polled: ${escHtml(relativeTime(platformState.lastPollAt))}
        </time>`
    : `<span data-radiant-meta>Never polled</span>`;

  // Error banner — shown only in degraded state
  const errorBanner = status === "degraded" && platformState.lastError !== undefined
    ? `<div role="alert" data-radiant-alert data-radiant-alert-variant="warning">
          <p data-radiant-alert-body>
            <strong>Last poll error:</strong>
            ${escHtml(platformState.lastError)}
          </p>
        </div>`
    : "";

  // Auth-failure banner — shown when token was rejected
  const authBanner = status === "auth_failed"
    ? `<div role="alert" data-radiant-alert data-radiant-alert-variant="error">
          <p data-radiant-alert-body>
            Authentication failed. Your token may have expired or been revoked.
            <a href="#" data-radiant-link data-radiant-action="reconnect"
               data-radiant-platform="${escHtml(platform)}">
              Reconnect &rarr;
            </a>
          </p>
        </div>`
    : "";

  // Repo list
  const repoItems = platformState.monitoredRepos.length > 0
    ? platformState.monitoredRepos
      .map((repo) =>
        `<li data-radiant-repo-item>
              <a
                href="#"
                data-radiant-link
                data-radiant-action="open_repo"
                data-radiant-platform="${escHtml(platform)}"
                data-radiant-repo="${escHtml(repo)}">
                ${escHtml(repo)}
              </a>
            </li>`
      )
      .join("\n            ")
    : `<li data-radiant-empty-state>No repositories configured.</li>`;

  return `<section
    data-radiant-platform-card
    data-radiant-platform="${escHtml(platform)}"
    data-radiant-status="${escHtml(status)}"
    aria-label="${escHtml(platformLabel)} connection">

    <header data-radiant-platform-card-header>
      <h2 data-radiant-heading="3" data-radiant-platform-title>
        ${escHtml(platformLabel)}
        ${statusDot}
      </h2>
      <p data-radiant-username>
        Signed in as
        <strong>${escHtml(platformState.username)}</strong>
      </p>
      ${lastPolled}
    </header>

    ${errorBanner}
    ${authBanner}

    <div data-radiant-platform-card-body>
      <h3 data-radiant-heading="4">Monitored repositories
        <span data-radiant-badge="neutral">
          ${escHtml(String(platformState.monitoredRepos.length))}
        </span>
      </h3>
      <ul data-radiant-repo-list aria-label="${escHtml(platformLabel)} monitored repositories">
        ${repoItems}
      </ul>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Event feed renderer
// ---------------------------------------------------------------------------

/**
 * Renders a single event item in the recent-events feed list.
 *
 * Each item shows the event kind badge, repository and platform source,
 * actor (if present), a link to the event, and the relative timestamp.
 *
 * @param event - The dashboard event to render.
 * @returns An HTML `<li>` string for the event.
 */
function renderEventItem(event: DashboardEvent): string {
  const kindLabel = eventKindLabel(event.kind);
  const relTime = relativeTime(event.occurredAt);
  const actorHtml = event.actor !== undefined
    ? `<span data-radiant-event-actor> by <strong>${escHtml(event.actor)}</strong></span>`
    : "";

  return `<li
    data-radiant-event-item
    data-radiant-event-kind="${escHtml(event.kind)}"
    data-radiant-platform="${escHtml(event.platform)}">

    <span data-radiant-event-badge data-radiant-event-kind="${escHtml(event.kind)}">
      ${escHtml(kindLabel)}
    </span>

    <div data-radiant-event-body>
      <a
        href="${escHtml(event.url)}"
        data-radiant-link
        target="_blank"
        rel="noopener noreferrer"
        data-radiant-event-title>
        ${escHtml(event.title)}
      </a>
      ${actorHtml}
      <span data-radiant-event-meta>
        ${escHtml(event.repo)}
        &middot;
        ${escHtml(event.platform === "github" ? "GitHub" : "GitLab")}
        &middot;
        <time datetime="${escHtml(event.occurredAt)}">${escHtml(relTime)}</time>
      </span>
    </div>
  </li>`;
}

/**
 * Renders the recent-events feed section.
 *
 * Shows up to the most recent events passed in `events`. When the list
 * is empty, an empty-state message is shown instead.
 *
 * @param events - Array of {@link DashboardEvent} objects to display,
 *   ordered most-recent first.
 * @returns An HTML string for the events feed section.
 */
function renderEventsFeed(events: DashboardEvent[]): string {
  const itemsHtml = events.length > 0
    ? events
      .map(renderEventItem)
      .join("\n    ")
    : `<li data-radiant-empty-state>
        No recent events. The monitor will notify you when activity is detected.
      </li>`;

  return `<section data-radiant-events-feed aria-label="Recent events">
    <h2 data-radiant-heading="3">Recent Events</h2>
    <ul data-radiant-event-list>
      ${itemsHtml}
    </ul>
  </section>`;
}

// ---------------------------------------------------------------------------
// Poll-interval settings form
// ---------------------------------------------------------------------------

/**
 * Renders the poll-interval settings form, allowing the user to change how
 * frequently the monitor polls for new events.
 *
 * The form uses the `"update_poll_interval"` action identifier and submits
 * a `minutes` field with the selected value.
 *
 * @param currentMinutes - The currently configured poll interval in minutes.
 * @returns An HTML string for the poll-interval form.
 */
function renderPollIntervalForm(currentMinutes: number): string {
  const options = [2, 5, 10, 15, 30]
    .map((mins) => {
      const selected = mins === currentMinutes ? " selected" : "";
      const label = mins === 1 ? "1 minute" : `${mins} minutes`;
      return `<option value="${mins}"${selected}>${escHtml(label)}</option>`;
    })
    .join("\n          ");

  return `<section data-radiant-settings-section aria-label="Poll interval settings">
    <h2 data-radiant-heading="3">Poll Interval</h2>
    <p data-radiant-body>
      How often the monitor checks for new pull requests, CI runs, and alerts.
      Current: <strong>${escHtml(String(currentMinutes))} minute${currentMinutes === 1 ? "" : "s"}</strong>.
    </p>
    <form
      data-radiant-form
      data-radiant-action="update_poll_interval"
      method="post"
      novalidate>
      <div data-radiant-field data-radiant-inline>
        <label for="poll-interval" data-radiant-label>Check every</label>
        <select
          id="poll-interval"
          name="minutes"
          data-radiant-select
          aria-label="Poll interval in minutes">
          ${options}
        </select>
        <button type="submit" data-radiant-button="secondary">
          Save
        </button>
      </div>
    </form>
  </section>`;
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Renders the main monitoring dashboard as a self-contained HTML fragment.
 *
 * The dashboard contains:
 * 1. **Platform connection cards** — one per configured platform (GitHub /
 *    GitLab), showing connection status (green/amber/red dot), signed-in
 *    username, list of monitored repositories, and last-polled timestamp.
 * 2. **Recent events feed** — chronological list of events from all
 *    monitored repos (review requests, CI failures, security alerts,
 *    merges, mentions, and issue assignments).
 * 3. **Poll interval settings** — an inline form to change how frequently
 *    the monitor polls.
 *
 * ## Status indicator logic
 *
 * | Dot colour | Condition |
 * |---|---|
 * | Green | Platform configured; `lastError` is absent or empty. |
 * | Amber | Platform configured; `lastError` is set on platform state. |
 * | Red | Platform configured; `authFailed === true` on platform state. |
 *
 * When neither `github` nor `gitlab` is present on `state`, this function
 * delegates to {@link renderEmptyState} and returns its output.
 *
 * @param state - Current {@link MonitorState} read from `monitor/store.ts`.
 * @param recentEvents - Array of {@link DashboardEvent} objects ordered
 *   most-recent first. Pass an empty array when no events are available.
 * @returns A valid HTML string for the full dashboard view.
 *
 * @example
 * ```ts
 * import { renderDashboard } from "~/ui/dashboard.ts";
 * import { loadState } from "~/monitor/store.ts";
 *
 * const state = await loadState();
 * const html = renderDashboard(state, []);
 * ```
 */
export function renderDashboard(state: MonitorState, recentEvents: DashboardEvent[]): string {
  // Fall back to empty state if nothing is configured
  if (state.github === undefined && state.gitlab === undefined) {
    return renderEmptyState();
  }

  // Build the platform cards for whichever platforms are configured
  const platformCards: string[] = [];
  if (state.github !== undefined) {
    platformCards.push(renderPlatformCard("github", state.github));
  }
  if (state.gitlab !== undefined) {
    platformCards.push(renderPlatformCard("gitlab", state.gitlab));
  }

  const platformsHtml = platformCards.join("\n\n  ");

  return `<article data-radiant-dashboard>
  <header data-radiant-dashboard-header>
    <h1 data-radiant-heading="2">Git Monitor</h1>
    <p data-radiant-body>
      Monitoring ${escHtml(String(platformCards.length))}
      ${platformCards.length === 1 ? "platform" : "platforms"}.
    </p>
  </header>

  <div data-radiant-platform-grid>
    ${platformsHtml}
  </div>

  ${renderEventsFeed(recentEvents)}

  ${renderPollIntervalForm(state.settings.pollIntervalMinutes)}
</article>`;
}

/**
 * Renders the empty-state screen shown when no platforms have been configured.
 *
 * Invites the user to run the setup wizard to connect a GitHub or GitLab
 * account. This screen is also returned by {@link renderDashboard} when
 * `state.github` and `state.gitlab` are both `undefined`.
 *
 * @returns A non-empty HTML string for the empty-state view.
 *
 * @example
 * ```ts
 * import { renderEmptyState } from "~/ui/dashboard.ts";
 *
 * const html = renderEmptyState();
 * // Returns an HTML fragment prompting the user to run the setup wizard
 * ```
 */
export function renderEmptyState(): string {
  return `<article data-radiant-dashboard data-radiant-dashboard-empty>
  <div data-radiant-empty-state-container>
    <header data-radiant-empty-state-header>
      <h1 data-radiant-heading="2">Git Monitor</h1>
      <p data-radiant-body>
        No platforms are connected yet. Connect a GitHub or GitLab account
        to start monitoring pull requests, CI pipelines, security alerts,
        and more.
      </p>
    </header>

    <section data-radiant-card data-radiant-card-variant="neutral" aria-label="Get started">
      <h2 data-radiant-heading="3">Get started</h2>
      <ul data-radiant-feature-list>
        <li>Pull request review requests and merge notifications</li>
        <li>CI/CD pipeline failures on protected branches</li>
        <li>Dependency and security vulnerability alerts</li>
        <li>@mentions in issues, pull requests, and comments</li>
      </ul>
    </section>

    <form
      data-radiant-form
      data-radiant-action="open_setup_wizard"
      method="post"
      novalidate>
      <footer data-radiant-empty-state-footer>
        <button type="submit" data-radiant-button="primary">
          Connect a platform &rarr;
        </button>
      </footer>
    </form>
  </div>
</article>`;
}
