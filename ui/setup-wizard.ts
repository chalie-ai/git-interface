/**
 * @module ui/setup-wizard
 *
 * Onboarding wizard for connecting GitHub and GitLab accounts to the
 * Chalie Git Interface tool.
 *
 * Renders HTML fragments using semantic markup with `data-radiant-*`
 * attribute hooks compatible with Chalie's Radiant design system.
 * No external CSS imports are used; all styling is delegated to the
 * host shell via the attribute hooks.
 *
 * ## Wizard Steps
 *
 * | Step | Name             | Description                                        |
 * |------|------------------|----------------------------------------------------|
 * | 1    | Platform         | Choose GitHub or GitLab.                           |
 * | 2    | Token Entry      | Enter a Personal Access Token (masked input).      |
 * | 3    | Validation       | Displays authenticated username and token expiry.  |
 * | 4    | Repo Selection   | Choose repositories to monitor.                    |
 *
 * ## Action Flow
 *
 * ```
 * Step 1 → handleSetupAction("select_platform", {platform})
 *        → returns renderSetupWizard(platform, 2)
 *
 * Step 2 → handleSetupAction("save_token", {platform, token, baseUrl?})
 *        → validates token via API, stores via secrets.set(), persists
 *          tokenRef+username to state
 *        → returns step-3 result HTML (no raw token in output)
 *
 * Step 3 → handleSetupAction("load_repos", {platform})
 *        → fetches repos using stored token
 *        → returns step-4 HTML with repo checkboxes
 *
 * Step 4 → handleSetupAction("save_repos", {platform, repos: string[]})
 *        → persists selected repos to state
 *        → returns completion HTML
 * ```
 *
 * ## Security Invariants
 *
 * - Raw token values are **never** written to application state or returned
 *   in any HTML string.
 * - All tokens are stored exclusively via {@link secrets.set} from
 *   `@chalie/interface-sdk`, which delegates to the Chalie secrets API
 *   or the encrypted file fallback.
 * - Only an opaque `tokenRef` key is persisted in `monitor.json`.
 */

import type { Platform, Repo } from "~/shared/mod.ts";
import { ApiError } from "~/shared/mod.ts";
import { secrets } from "@chalie/interface-sdk";
import { loadState, saveState } from "~/monitor/store.ts";
import type { GitHubPlatformState, GitLabPlatformState } from "~/monitor/store.ts";
import { listRepos } from "~/github/mod.ts";
import { listProjects } from "~/gitlab/mod.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** GitHub REST API base URL. */
const GITHUB_API = "https://api.github.com";

/** Default GitLab base URL (can be overridden for self-managed instances). */
const GITLAB_DEFAULT_BASE = "https://gitlab.com";

// ---------------------------------------------------------------------------
// HTML utilities
// ---------------------------------------------------------------------------

/**
 * Escapes a plain-text string for safe insertion into HTML content or
 * attribute values.
 *
 * Replaces the five HTML-special characters (`&`, `<`, `>`, `"`, `'`) with
 * their named entity equivalents.
 *
 * **Important:** This function must be called on every piece of user-supplied
 * or API-returned data before it is embedded in HTML to prevent XSS.
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
 * Renders a step-progress indicator bar showing which wizard step is active.
 *
 * @param current - The 1-based index of the currently active step (1–4).
 * @param total - Total number of steps (default 4).
 * @returns An HTML string containing the progress indicator.
 */
function renderStepProgress(current: number, total = 4): string {
  const steps = [
    "Platform",
    "Token",
    "Validate",
    "Repositories",
  ];

  const items = steps
    .slice(0, total)
    .map((label, i) => {
      const stepNum = i + 1;
      const isActive = stepNum === current;
      const isComplete = stepNum < current;
      const state = isComplete ? "complete" : isActive ? "active" : "pending";
      return `<li data-radiant-step-item data-radiant-step-state="${state}" aria-current="${
        isActive ? "step" : "false"
      }">
        <span data-radiant-step-number>${escHtml(String(stepNum))}</span>
        <span data-radiant-step-label>${escHtml(label)}</span>
      </li>`;
    })
    .join("\n      ");

  return `<nav data-radiant-step-progress aria-label="Setup progress">
    <ol data-radiant-step-list>
      ${items}
    </ol>
  </nav>`;
}

/**
 * Wraps inner HTML in the standard wizard card layout with a step-progress
 * header and optional back-link.
 *
 * @param inner - The inner HTML string for the card body.
 * @param currentStep - The 1-based active step number.
 * @param platform - The currently selected platform, used for back-links.
 * @returns A complete wizard card HTML string.
 */
function wrapWizardCard(inner: string, currentStep: number, platform: Platform): string {
  const backLink = currentStep > 1
    ? `<a href="#" data-radiant-back-link data-radiant-action="go_step"
          data-radiant-step="${currentStep - 1}" data-radiant-platform="${escHtml(platform)}">
        &larr; Back
      </a>`
    : "";

  return `<article data-radiant-wizard data-radiant-platform="${
    escHtml(platform)
  }" data-radiant-step="${currentStep}">
  ${renderStepProgress(currentStep)}
  <div data-radiant-wizard-body>
    ${backLink}
    ${inner}
  </div>
</article>`;
}

/**
 * Renders a callout box containing a list of items.
 *
 * @param title - Heading text for the callout.
 * @param items - Array of plain-text list items.
 * @param variant - Visual variant passed to `data-radiant-callout-variant`.
 * @returns An HTML callout string.
 */
function renderCallout(title: string, items: string[], variant = "info"): string {
  const listItems = items
    .map((item) => `<li>${escHtml(item)}</li>`)
    .join("\n        ");
  return `<aside data-radiant-callout data-radiant-callout-variant="${escHtml(variant)}">
      <p data-radiant-callout-title><strong>${escHtml(title)}</strong></p>
      <ul>
        ${listItems}
      </ul>
    </aside>`;
}

/**
 * Renders a non-fatal inline error message.
 *
 * @param message - User-facing error description (HTML-escaped internally).
 * @returns An HTML string for the error banner.
 */
function renderErrorBanner(message: string): string {
  return `<div role="alert" data-radiant-alert data-radiant-alert-variant="error">
    <p>${escHtml(message)}</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Step renderers — synchronous, platform-aware
// ---------------------------------------------------------------------------

/**
 * Renders Step 1: platform selection.
 *
 * Displays radio button cards for GitHub and GitLab with brief descriptions.
 * Submitting the form triggers the `"select_platform"` action.
 *
 * @returns HTML string for step 1.
 */
function renderStep1(): string {
  const inner = `<header data-radiant-wizard-header>
      <h2 data-radiant-heading="2">Connect Your Git Platform</h2>
      <p data-radiant-body>Choose the platform you want to monitor.</p>
    </header>

    <form
      data-radiant-form
      data-radiant-action="select_platform"
      method="post"
      novalidate>

      <fieldset data-radiant-fieldset>
        <legend data-radiant-legend>Select a platform</legend>

        <label data-radiant-radio-card for="platform-github">
          <input
            type="radio"
            id="platform-github"
            name="platform"
            value="github"
            data-radiant-radio
            required>
          <span data-radiant-radio-card-title>GitHub</span>
          <span data-radiant-radio-card-description>
            github.com — public &amp; private repositories, GitHub Actions,
            Dependabot alerts.
          </span>
        </label>

        <label data-radiant-radio-card for="platform-gitlab">
          <input
            type="radio"
            id="platform-gitlab"
            name="platform"
            value="gitlab"
            data-radiant-radio>
          <span data-radiant-radio-card-title>GitLab</span>
          <span data-radiant-radio-card-description>
            gitlab.com or self-managed — merge requests, pipelines,
            vulnerability reports.
          </span>
        </label>
      </fieldset>

      <footer data-radiant-wizard-footer>
        <button type="submit" data-radiant-button="primary">
          Continue
        </button>
      </footer>
    </form>`;

  // Step 1 has no platform yet; we default to "github" for the wrapper
  // attribute, but both platforms are offered.
  return wrapWizardCard(inner, 1, "github");
}

/**
 * Renders Step 2: token entry for the given platform.
 *
 * Displays a password input and platform-specific PAT permission
 * instructions. Submitting the form triggers the `"save_token"` action
 * which validates and stores the token via the secrets API.
 *
 * The input field uses `type="password"` so the value is masked in the UI
 * and never reflected back into any HTML or log output.
 *
 * @param platform - The selected platform (`"github"` or `"gitlab"`).
 * @returns HTML string for step 2.
 */
function renderStep2(platform: Platform): string {
  const isGitHub = platform === "github";
  const platformLabel = isGitHub ? "GitHub" : "GitLab";
  const tokenPlaceholder = isGitHub ? "ghp_… or github_pat_…" : "glpat-…";
  const tokenHint = isGitHub
    ? "Classic tokens and fine-grained personal access tokens are both accepted."
    : "Use a personal access token with the <code>api</code> scope.";

  const githubFineGrainedCallout = renderCallout(
    "Fine-grained PAT — recommended permissions",
    [
      "Contents: Read",
      "Issues: Read & Write",
      "Pull Requests: Read & Write",
      "Actions (Workflows): Read",
      "Dependabot alerts: Read",
      "Secret scanning alerts: Read",
    ],
    "info",
  );

  const githubClassicCallout = renderCallout(
    "Classic PAT — required scopes",
    ["repo", "read:user", "notifications", "security_events"],
    "neutral",
  );

  const gitlabCallout = renderCallout(
    "Required GitLab PAT scopes",
    ["api (full API access including read/write for issues and merge requests)"],
    "info",
  );

  const permissionsBlock = isGitHub
    ? `<details data-radiant-details>
        <summary data-radiant-summary>Required token permissions</summary>
        <div data-radiant-details-content>
          ${githubFineGrainedCallout}
          <p data-radiant-body data-radiant-mt="sm">
            Fine-grained tokens provide tighter access control and are recommended.
            Classic tokens also work — select the scopes below.
          </p>
          ${githubClassicCallout}
          <p data-radiant-body data-radiant-mt="sm">
            <a
              href="https://github.com/settings/tokens?type=beta"
              target="_blank"
              rel="noopener noreferrer"
              data-radiant-link>
              Create a fine-grained token on GitHub &#x2197;
            </a>
          </p>
        </div>
      </details>`
    : `<details data-radiant-details open>
        <summary data-radiant-summary>Required token permissions</summary>
        <div data-radiant-details-content>
          ${gitlabCallout}
          <p data-radiant-body data-radiant-mt="sm">
            <a
              href="https://gitlab.com/-/user_settings/personal_access_tokens"
              target="_blank"
              rel="noopener noreferrer"
              data-radiant-link>
              Create a personal access token on GitLab &#x2197;
            </a>
          </p>
        </div>
      </details>`;

  const baseUrlField = !isGitHub
    ? `<div data-radiant-field>
          <label for="baseUrl" data-radiant-label>
            GitLab instance URL
            <span data-radiant-badge="neutral">Optional — gitlab.com is the default</span>
          </label>
          <input
            type="url"
            id="baseUrl"
            name="baseUrl"
            value="https://gitlab.com"
            autocomplete="url"
            placeholder="https://gitlab.com"
            data-radiant-input>
          <small data-radiant-hint>
            Leave unchanged for gitlab.com. For self-managed instances enter
            your root URL (e.g.&nbsp;<code>https://gitlab.mycompany.com</code>).
          </small>
        </div>`
    : "";

  const inner = `<header data-radiant-wizard-header>
      <h2 data-radiant-heading="2">${escHtml(platformLabel)} Personal Access Token</h2>
      <p data-radiant-body>
        Enter your token below. It is masked as you type and is stored securely —
        it will never appear in plain text in any configuration file.
      </p>
    </header>

    <form
      data-radiant-form
      data-radiant-action="save_token"
      method="post"
      novalidate>

      <input type="hidden" name="platform" value="${escHtml(platform)}">

      ${baseUrlField}

      <div data-radiant-field>
        <label for="token" data-radiant-label>
          Personal Access Token
          <abbr title="required" aria-label="required">*</abbr>
        </label>
        <input
          type="password"
          id="token"
          name="token"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="${escHtml(tokenPlaceholder)}"
          data-radiant-input
          required>
        <small data-radiant-hint>${tokenHint}</small>
      </div>

      ${permissionsBlock}

      <footer data-radiant-wizard-footer>
        <button type="submit" data-radiant-button="primary">
          Validate &amp; Save Token
        </button>
      </footer>
    </form>`;

  return wrapWizardCard(inner, 2, platform);
}

/**
 * Renders Step 3: token validation placeholder.
 *
 * This is the static scaffold returned by `renderSetupWizard` before
 * `handleSetupAction("save_token", …)` runs. The result HTML returned by
 * that action replaces this with the actual validated username and expiry.
 *
 * @param platform - The selected platform.
 * @returns HTML string for step 3 (loading state).
 */
function renderStep3Loading(platform: Platform): string {
  const inner = `<header data-radiant-wizard-header>
      <h2 data-radiant-heading="2">Validating Token&hellip;</h2>
      <p data-radiant-body>
        Verifying your token with the ${escHtml(platform === "github" ? "GitHub" : "GitLab")} API.
        This should take just a moment.
      </p>
    </header>
    <div data-radiant-spinner aria-live="polite" aria-busy="true">
      <span data-radiant-spinner-icon aria-hidden="true"></span>
      <span>Connecting&hellip;</span>
    </div>`;

  return wrapWizardCard(inner, 3, platform);
}

/**
 * Renders Step 3: validation success result.
 *
 * Called internally by `handleSetupAction("save_token", …)` once the
 * token has been validated and stored. Displays the authenticated
 * username and token expiry (when available). The raw token value is
 * **never** included in this output.
 *
 * @param platform - The selected platform.
 * @param username - Authenticated username returned by the platform API.
 * @param tokenExpiry - ISO 8601 expiry date string, or `null` if the
 *   token does not expire.
 * @returns HTML string for the step-3 success state.
 */
function renderStep3Success(
  platform: Platform,
  username: string,
  tokenExpiry: string | null,
): string {
  const platformLabel = platform === "github" ? "GitHub" : "GitLab";
  const expiryLine = tokenExpiry
    ? `<p data-radiant-body>
          <strong>Token expiry:</strong>
          <time datetime="${escHtml(tokenExpiry)}">${
      escHtml(new Date(tokenExpiry).toLocaleDateString())
    }</time>
        </p>`
    : `<p data-radiant-body>
          <strong>Token expiry:</strong>
          <span data-radiant-badge="success">No expiry (non-expiring token)</span>
        </p>`;

  const inner = `<header data-radiant-wizard-header>
      <h2 data-radiant-heading="2">Connected to ${escHtml(platformLabel)}</h2>
      <p data-radiant-body>
        Your token was validated and stored securely. Only an opaque
        reference key is saved — the raw token will not appear in any file.
      </p>
    </header>

    <section data-radiant-card data-radiant-card-variant="success" aria-label="Connection details">
      <p data-radiant-body>
        <strong>Signed in as:</strong>
        <span data-radiant-username>${escHtml(username)}</span>
      </p>
      ${expiryLine}
      <p data-radiant-body>
        <strong>Platform:</strong> ${escHtml(platformLabel)}
      </p>
    </section>

    <form
      data-radiant-form
      data-radiant-action="load_repos"
      method="post"
      novalidate>
      <input type="hidden" name="platform" value="${escHtml(platform)}">
      <footer data-radiant-wizard-footer>
        <button type="submit" data-radiant-button="primary">
          Choose Repositories &rarr;
        </button>
      </footer>
    </form>`;

  return wrapWizardCard(inner, 3, platform);
}

/**
 * Renders Step 4: repository selection placeholder.
 *
 * Static scaffold shown before `handleSetupAction("load_repos", …)` runs.
 * The repos list is fetched asynchronously and replaces this view.
 *
 * @param platform - The selected platform.
 * @returns HTML string for the step-4 loading state.
 */
function renderStep4Loading(platform: Platform): string {
  const inner = `<header data-radiant-wizard-header>
      <h2 data-radiant-heading="2">Select Repositories</h2>
      <p data-radiant-body>Loading your repositories&hellip;</p>
    </header>
    <div data-radiant-spinner aria-live="polite" aria-busy="true">
      <span data-radiant-spinner-icon aria-hidden="true"></span>
      <span>Fetching repository list&hellip;</span>
    </div>`;

  return wrapWizardCard(inner, 4, platform);
}

/**
 * Renders Step 4: repository selection with a populated repo list.
 *
 * Called internally by `handleSetupAction("load_repos", …)`. Each repo
 * is rendered as a labelled checkbox. Submitting the form triggers the
 * `"save_repos"` action.
 *
 * @param platform - The selected platform.
 * @param repos - Array of normalised `Repo` objects to display as checkboxes.
 * @param alreadySelected - `owner/repo` strings that should be pre-checked
 *   (e.g. previously persisted selections).
 * @returns HTML string for the step-4 repo selection state.
 */
function renderStep4WithRepos(
  platform: Platform,
  repos: Repo[],
  alreadySelected: string[],
): string {
  const selectedSet = new Set(alreadySelected);

  const repoItems = repos
    .map((repo) => {
      const checked = selectedSet.has(repo.fullName) ? " checked" : "";
      const privateLabel = repo.isPrivate
        ? `<span data-radiant-badge="neutral" aria-label="private repository">Private</span>`
        : `<span data-radiant-badge="success" aria-label="public repository">Public</span>`;
      const langLabel = repo.language
        ? `<span data-radiant-badge="language">${escHtml(repo.language)}</span>`
        : "";
      return `<li data-radiant-repo-item>
          <label data-radiant-checkbox-card for="repo-${escHtml(repo.id)}">
            <input
              type="checkbox"
              id="repo-${escHtml(repo.id)}"
              name="repos"
              value="${escHtml(repo.fullName)}"
              data-radiant-checkbox
              ${checked}>
            <span data-radiant-checkbox-card-body>
              <span data-radiant-repo-name>${escHtml(repo.fullName)}</span>
              <span data-radiant-repo-badges>
                ${privateLabel}
                ${langLabel}
              </span>
              ${
        repo.description
          ? `<small data-radiant-repo-description>${escHtml(repo.description)}</small>`
          : ""
      }
            </span>
          </label>
        </li>`;
    })
    .join("\n        ");

  const emptyState = repos.length === 0
    ? `<p data-radiant-empty-state>
        No repositories found. Make sure your token has the correct permissions.
      </p>`
    : "";

  const inner = `<header data-radiant-wizard-header>
      <h2 data-radiant-heading="2">Select Repositories to Monitor</h2>
      <p data-radiant-body>
        Choose which repositories you want the monitor to track.
        You can change this later in settings.
      </p>
    </header>

    <form
      data-radiant-form
      data-radiant-action="save_repos"
      method="post"
      novalidate>
      <input type="hidden" name="platform" value="${escHtml(platform)}">

      ${emptyState}

      <ul data-radiant-repo-list aria-label="Repository list">
        ${repoItems}
      </ul>

      <footer data-radiant-wizard-footer>
        <button
          type="button"
          data-radiant-button="secondary"
          data-radiant-action="select_all_repos"
          data-radiant-platform="${escHtml(platform)}">
          Select all
        </button>
        <button type="submit" data-radiant-button="primary">
          Save &amp; Finish Setup &rarr;
        </button>
      </footer>
    </form>`;

  return wrapWizardCard(inner, 4, platform);
}

/**
 * Renders a wizard-complete confirmation screen.
 *
 * Displayed after the user saves their repo selection in step 4.
 *
 * @param platform - The platform that was just configured.
 * @param repoCount - Number of repos saved for monitoring.
 * @returns HTML string for the setup-complete confirmation.
 */
function renderComplete(platform: Platform, repoCount: number): string {
  const platformLabel = platform === "github" ? "GitHub" : "GitLab";
  return `<article data-radiant-wizard data-radiant-platform="${
    escHtml(platform)
  }" data-radiant-step="complete">
  <div data-radiant-wizard-body>
    <header data-radiant-wizard-header>
      <h2 data-radiant-heading="2">Setup Complete</h2>
      <p data-radiant-body>
        ${escHtml(platformLabel)} is connected and
        ${escHtml(String(repoCount))} ${repoCount === 1 ? "repository" : "repositories"}
        will be monitored.
      </p>
    </header>
    <section data-radiant-card data-radiant-card-variant="success">
      <p data-radiant-body>
        The monitor will poll for new pull request reviews, CI failures,
        security alerts, and @mentions every 5&nbsp;minutes.
      </p>
      <p data-radiant-body>
        You can adjust the poll interval and notification preferences in
        settings at any time.
      </p>
    </section>
  </div>
</article>`;
}

// ---------------------------------------------------------------------------
// Token validation helpers
// ---------------------------------------------------------------------------

/**
 * Describes the result of a successful token-validation API call.
 */
interface TokenValidationResult {
  /** Authenticated username on the platform. */
  username: string;
  /**
   * ISO 8601 token expiry date returned by the API, or `null` when the
   * token has no expiry.
   */
  tokenExpiry: string | null;
}

/**
 * Validates a GitHub Personal Access Token by calling `GET /user`.
 *
 * On success returns the authenticated username and token expiry
 * (read from the `GitHub-Authentication-Token-Expiration` response header,
 * when present).
 *
 * @param token - The GitHub PAT to validate.
 * @returns A `TokenValidationResult` with username and optional expiry.
 * @throws `ApiError` with `code: "auth_failed"` if the token is invalid or
 *   expired; other `ApiError` codes for server / network failures.
 */
async function validateGitHubToken(token: string): Promise<TokenValidationResult> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (err) {
    throw new ApiError({
      platform: "github",
      status: 0,
      code: "network",
      message: `Network error while validating GitHub token: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  if (response.status === 401) {
    await response.body?.cancel();
    throw new ApiError({
      platform: "github",
      status: 401,
      code: "auth_failed",
      message: "GitHub token is invalid or has expired. Please check the token and try again.",
    });
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError({
      platform: "github",
      status: response.status,
      code: response.status >= 500 ? "server_error" : "forbidden",
      message: `GitHub API returned HTTP ${response.status} while validating token.`,
    });
  }

  const body = (await response.json()) as { login?: string };
  const username = body.login ?? "unknown";
  // The header is present only when the token has an expiry date set.
  const tokenExpiry = response.headers.get("GitHub-Authentication-Token-Expiration");

  return { username, tokenExpiry };
}

/**
 * Validates a GitLab Personal Access Token by calling `GET /api/v4/user`.
 *
 * @param token - The GitLab PAT to validate.
 * @param baseUrl - GitLab instance root URL (default: `"https://gitlab.com"`).
 * @returns A `TokenValidationResult` with username; `tokenExpiry` is always
 *   `null` because GitLab does not expose token expiry on this endpoint.
 * @throws `ApiError` with `code: "auth_failed"` if the token is invalid.
 */
async function validateGitLabToken(
  token: string,
  baseUrl: string,
): Promise<TokenValidationResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/v4/user`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "PRIVATE-TOKEN": token,
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw new ApiError({
      platform: "gitlab",
      status: 0,
      code: "network",
      message: `Network error while validating GitLab token: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  if (response.status === 401) {
    await response.body?.cancel();
    throw new ApiError({
      platform: "gitlab",
      status: 401,
      code: "auth_failed",
      message: "GitLab token is invalid or has expired. Please check the token and try again.",
    });
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError({
      platform: "gitlab",
      status: response.status,
      code: response.status >= 500 ? "server_error" : "forbidden",
      message: `GitLab API returned HTTP ${response.status} while validating token.`,
    });
  }

  const body = (await response.json()) as { username?: string };
  const username = body.username ?? "unknown";

  return { username, tokenExpiry: null };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Renders the setup wizard HTML for the given platform and step number.
 *
 * Returns a self-contained HTML fragment using semantic elements with
 * `data-radiant-*` attribute hooks. No external stylesheets or scripts
 * are referenced; the Radiant shell applies visual styling via the hooks.
 *
 * Steps 3 and 4 returned by this function are loading placeholders —
 * the full content for those steps is produced by {@link handleSetupAction}
 * once asynchronous work (API validation, repo fetching) completes.
 *
 * @param platform - The platform for which to render wizard steps 2–4.
 *   For step 1, either value renders the same platform-selection screen.
 * @param step - The 1-based wizard step to render (1–4). Out-of-range
 *   values fall back to step 1.
 * @returns A valid HTML string for the requested step.
 *
 * @example
 * ```ts
 * const html = renderSetupWizard("github", 1);
 * // Returns platform-selection screen
 *
 * const html2 = renderSetupWizard("github", 2);
 * // Returns GitHub token-entry form with fine-grained PAT instructions
 * ```
 */
export function renderSetupWizard(platform: Platform, step: number): string {
  switch (step) {
    case 1:
      return renderStep1();
    case 2:
      return renderStep2(platform);
    case 3:
      return renderStep3Loading(platform);
    case 4:
      return renderStep4Loading(platform);
    default:
      return renderStep1();
  }
}

/**
 * Processes a setup wizard form submission and returns the next HTML state.
 *
 * This is the primary controller for the wizard. Each named action advances
 * the wizard by performing async work (API calls, secret storage, state
 * persistence) and returning an HTML string for the next step.
 *
 * ## Actions
 *
 * | Action            | Payload fields                           | Description |
 * |-------------------|------------------------------------------|-------------|
 * | `select_platform` | `platform`                               | Renders step 2 for the chosen platform. |
 * | `save_token`      | `platform`, `token`, `baseUrl?`          | Validates token via API, stores via `secrets.set()`, persists `tokenRef` to state, renders step-3 success view. **Raw token never appears in return value.** |
 * | `load_repos`      | `platform`                               | Fetches repos using stored token, renders step-4 repo selection. |
 * | `save_repos`      | `platform`, `repos` (string array)       | Persists selected repos to state, renders completion screen. |
 *
 * ## Security guarantee
 *
 * When `action === "save_token"`, `payload.token` is:
 * 1. Passed to the platform API for validation.
 * 2. Passed to `secrets.set(tokenRef, rawToken)` for secure storage.
 * 3. Never written to `monitor.json`, logs, or any returned HTML.
 *
 * @param action - The wizard action identifier (see table above).
 * @param payload - Key-value map of form field values. Must not be empty
 *   for any action that requires a `platform` field.
 * @returns A promise resolving to an HTML string for the next wizard state,
 *   or an error banner HTML string if the action fails.
 *
 * @example
 * ```ts
 * // Step 1 → step 2
 * const html = await handleSetupAction("select_platform", { platform: "github" });
 *
 * // Step 2 → step 3 (validates + stores token; raw token never in return)
 * const html2 = await handleSetupAction("save_token", {
 *   platform: "github",
 *   token: "ghp_xxxxxxxxxxxx",
 * });
 *
 * // Step 3 → step 4 (load repo list)
 * const html3 = await handleSetupAction("load_repos", { platform: "github" });
 *
 * // Step 4 → complete
 * const html4 = await handleSetupAction("save_repos", {
 *   platform: "github",
 *   repos: ["owner/repo-a", "owner/repo-b"],
 * });
 * ```
 */
export async function handleSetupAction(
  action: string,
  payload: Record<string, unknown>,
): Promise<string> {
  try {
    switch (action) {
      case "select_platform":
        return handleSelectPlatform(payload);

      case "save_token":
        return await handleSaveToken(payload);

      case "load_repos":
        return await handleLoadRepos(payload);

      case "save_repos":
        return await handleSaveRepos(payload);

      default:
        return renderErrorBanner(`Unknown action: "${escHtml(action)}".`);
    }
  } catch (err) {
    if (err instanceof ApiError) {
      return renderErrorBanner(err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return renderErrorBanner(`An unexpected error occurred: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Action handlers (private)
// ---------------------------------------------------------------------------

/**
 * Handles the `"select_platform"` wizard action.
 *
 * Reads the chosen platform from `payload.platform` and returns the
 * token-entry HTML for step 2.
 *
 * @param payload - Must contain `platform: "github" | "gitlab"`.
 * @returns HTML string for wizard step 2.
 */
function handleSelectPlatform(payload: Record<string, unknown>): string {
  const platform = normalisePlatform(payload["platform"]);
  return renderStep2(platform);
}

/**
 * Handles the `"save_token"` wizard action.
 *
 * Workflow:
 * 1. Extracts the raw token from `payload.token` (never echoed back).
 * 2. Validates the token against the platform API (`GET /user`).
 * 3. Stores the raw token via `secrets.set(tokenRef, rawToken)`.
 * 4. Persists `tokenRef` and `username` to `monitor.json` (no raw token).
 * 5. Clears all references to the raw token from local scope.
 * 6. Returns step-3 success HTML showing username and optional expiry.
 *
 * @param payload - Must contain `platform`, `token`; optionally `baseUrl`
 *   (for GitLab self-managed instances).
 * @returns HTML string for the step-3 success view.
 * @throws `ApiError` on validation failure (caught by `handleSetupAction`).
 */
async function handleSaveToken(payload: Record<string, unknown>): Promise<string> {
  const platform = normalisePlatform(payload["platform"]);

  // Extract the raw token. We deliberately do not log, re-assign, or embed
  // this value anywhere beyond the two calls below.
  const rawToken = normaliseString(payload["token"], "token");
  if (rawToken.length === 0) {
    return renderErrorBanner("Token is required. Please enter your Personal Access Token.");
  }

  const baseUrl = platform === "gitlab"
    ? normaliseString(payload["baseUrl"], "baseUrl", GITLAB_DEFAULT_BASE)
    : GITLAB_DEFAULT_BASE;

  // 1. Validate the token against the platform API.
  const validation: TokenValidationResult = platform === "github"
    ? await validateGitHubToken(rawToken)
    : await validateGitLabToken(rawToken, baseUrl);

  // 2. Derive a stable tokenRef key and store the raw token securely.
  //    After this call, rawToken is no longer needed.
  const tokenRef = `${platform}_token`;
  await secrets.set(tokenRef, rawToken);

  // 3. Persist tokenRef + username to monitor state (raw token excluded).
  const state = await loadState();
  const nowIso = new Date().toISOString();

  if (platform === "github") {
    const ghState: GitHubPlatformState = {
      tokenRef,
      username: validation.username,
      monitoredRepos: state.github?.monitoredRepos ?? [],
      lastPollAt: state.github?.lastPollAt ?? nowIso,
      seenEventIds: state.github?.seenEventIds ?? [],
    };
    state.github = ghState;
  } else {
    const glState: GitLabPlatformState = {
      tokenRef,
      baseUrl,
      username: validation.username,
      monitoredRepos: state.gitlab?.monitoredRepos ?? [],
      lastPollAt: state.gitlab?.lastPollAt ?? nowIso,
      seenEventIds: state.gitlab?.seenEventIds ?? [],
    };
    state.gitlab = glState;
  }

  await saveState(state);

  // 4. Return step-3 success HTML. Raw token is not included.
  return renderStep3Success(platform, validation.username, validation.tokenExpiry);
}

/**
 * Handles the `"load_repos"` wizard action.
 *
 * Retrieves the stored token via `secrets.get(tokenRef)`, fetches the list
 * of accessible repositories from the platform API, and renders step 4 with
 * repo checkboxes.
 *
 * @param payload - Must contain `platform`.
 * @returns HTML string for the step-4 repo selection view.
 * @throws `ApiError` on API failure (caught by `handleSetupAction`).
 */
async function handleLoadRepos(payload: Record<string, unknown>): Promise<string> {
  const platform = normalisePlatform(payload["platform"]);
  const state = await loadState();

  const platformState = platform === "github" ? state.github : state.gitlab;
  if (platformState === undefined) {
    return renderErrorBanner(
      `No ${platform === "github" ? "GitHub" : "GitLab"} account is connected. ` +
        `Please complete token setup first.`,
    );
  }

  const token = await secrets.get(platformState.tokenRef);
  if (token === null) {
    return renderErrorBanner(
      "Stored token could not be retrieved. Please re-enter your Personal Access Token.",
    );
  }

  let repos: Repo[];
  if (platform === "github") {
    repos = await listRepos(token);
  } else {
    repos = await listProjects(token);
  }

  return renderStep4WithRepos(platform, repos, platformState.monitoredRepos);
}

/**
 * Handles the `"save_repos"` wizard action.
 *
 * Writes the user-selected `owner/repo` strings to the platform's
 * `monitoredRepos` list in `monitor.json` and returns the completion screen.
 *
 * @param payload - Must contain `platform` and `repos` (a string or string
 *   array of `owner/repo` values to monitor).
 * @returns HTML string for the setup-complete confirmation view.
 */
async function handleSaveRepos(payload: Record<string, unknown>): Promise<string> {
  const platform = normalisePlatform(payload["platform"]);

  // `repos` may arrive as a single string (one checkbox) or an array.
  let repos: string[];
  if (Array.isArray(payload["repos"])) {
    repos = (payload["repos"] as unknown[]).flatMap((r) =>
      typeof r === "string" && r.length > 0 ? [r] : []
    );
  } else if (typeof payload["repos"] === "string" && payload["repos"].length > 0) {
    repos = [payload["repos"]];
  } else {
    repos = [];
  }

  const state = await loadState();

  if (platform === "github") {
    if (state.github === undefined) {
      return renderErrorBanner("GitHub account not connected. Please complete token setup.");
    }
    state.github.monitoredRepos = repos;
  } else {
    if (state.gitlab === undefined) {
      return renderErrorBanner("GitLab account not connected. Please complete token setup.");
    }
    state.gitlab.monitoredRepos = repos;
  }

  await saveState(state);
  return renderComplete(platform, repos.length);
}

// ---------------------------------------------------------------------------
// Payload normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Narrows an unknown payload value to the `Platform` union type.
 *
 * Accepts only `"github"` or `"gitlab"`; defaults to `"github"` for any
 * other value so callers always receive a valid `Platform`.
 *
 * @param value - Raw value from a form payload.
 * @returns `"github"` or `"gitlab"`.
 */
function normalisePlatform(value: unknown): Platform {
  if (value === "gitlab") return "gitlab";
  return "github";
}

/**
 * Narrows an unknown payload value to a trimmed string.
 *
 * Returns `fallback` when the value is absent, not a string, or empty after
 * trimming.
 *
 * @param value - Raw value from a form payload.
 * @param _fieldName - Field name (unused at runtime; retained for readability).
 * @param fallback - Default string to return when the value is absent or empty.
 * @returns The trimmed string value, or `fallback`.
 */
function normaliseString(
  value: unknown,
  _fieldName: string,
  fallback = "",
): string {
  if (typeof value === "string") return value.trim();
  return fallback;
}
