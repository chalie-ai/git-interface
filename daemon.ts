/**
 * @file daemon.ts
 * @description SDK daemon entry point for the Chalie Git Interface.
 *
 * Bridges the existing 18 capability handlers and the background monitor
 * poller to the Chalie Interface SDK's daemon model so the
 * interface_daemon_worker can auto-discover and manage this interface.
 *
 * The daemon worker finds this file at the repo root and starts it with:
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     daemon.ts --gateway=<url> --port=<port> --data-dir=<dir>
 *
 * The SDK's `createDaemon()` parses `--gateway` and `--port`. This file
 * parses `--data-dir` to locate the state directory for state persistence
 * and secrets storage.
 *
 * ## Startup sequence
 *
 * 1. Parse `--data-dir` CLI arg.
 * 2. Create secrets store backed by `{dataDir}/secrets.enc.json`.
 * 3. Load persistent monitor state from disk.
 * 4. If at least one platform is configured (and not auth-failed), start
 *    the background poller.
 * 5. Install SIGINT handler for clean shutdown.
 * 6. Call `createDaemon()` with all 18 capabilities, executeCommand
 *    dispatcher, and renderInterface for the UI.
 *
 * @module git-interface/daemon
 */

import {
  createDaemon,
  sendMessage,
  sendSignal,
} from "jsr:@chalie/interface-sdk@^1.1.0";

import { createSecrets } from "./src/secrets.ts";
import type { Secrets } from "./src/secrets.ts";
import { getState, loadState, saveState, setPollerSecrets, startPoller } from "~/monitor/mod.ts";
import type { MonitorState } from "~/monitor/mod.ts";
import { ApiError } from "~/shared/mod.ts";
import { setSecrets as setCapabilitySecrets } from "~/capabilities/index.ts";

import type { Block } from "../_sdk/blocks.ts";
import {
  actions,
  alert,
  badge,
  button,
  columns,
  divider,
  form,
  header,
  input,
  keyvalue,
  list,
  section,
  select,
  table,
  text,
} from "../_sdk/blocks.ts";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseCliArg(prefix: string): string | undefined {
  for (const arg of Deno.args) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

const dataDir = parseCliArg("--data-dir=") ??
  (() => {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "/";
    return `${home}/.chalie/git-interface`;
  })();

// ---------------------------------------------------------------------------
// Secrets store
// ---------------------------------------------------------------------------

/** Module-level secrets instance, initialised from dataDir. */
const secrets: Secrets = createSecrets(dataDir);

// Wire secrets into poller and capabilities
setPollerSecrets(secrets);
setCapabilitySecrets(secrets);

// Export for use by capability handlers and setup wizard
export { secrets, dataDir };

// ---------------------------------------------------------------------------
// Monitor state
// ---------------------------------------------------------------------------

/**
 * Override the store module's dataDir by setting the env var before loading
 * state. The store module reads from CHALIE_DATA_DIR or falls back.
 */
Deno.env.set("CHALIE_DATA_DIR", dataDir);

const initialState = await loadState();

// ---------------------------------------------------------------------------
// Poller startup
// ---------------------------------------------------------------------------

/**
 * Starts the background monitor poller if at least one platform is connected
 * and not in a permanently-failed auth state.
 */
function maybeStartPoller(state: MonitorState): void {
  const githubReady =
    state.github !== undefined && state.github.authFailed !== true;
  const gitlabReady =
    state.gitlab !== undefined && state.gitlab.authFailed !== true;

  if (githubReady || gitlabReady) {
    startPoller(state);
  }
}

maybeStartPoller(initialState);

// ---------------------------------------------------------------------------
// SIGINT handler — flush state before exit
// ---------------------------------------------------------------------------

Deno.addSignalListener("SIGINT", () => {
  saveState(getState()).finally(() => Deno.exit(0));
});

// ---------------------------------------------------------------------------
// Capability handler dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatches a capability call to the appropriate handler.
 *
 * The 18 handlers from capabilities/index.ts were designed around the
 * old `registerCapability` pattern where they receive a `CapabilityContext`.
 * In the daemon model, `executeCommand` receives (capability, params) and
 * we construct the context object inline.
 *
 * Rather than rewriting all 18 handlers, we import `registerAllCapabilities`
 * which populates the old registry, and then use the old `dispatch` function
 * to route calls. This preserves all existing handler logic.
 */
import { registerAllCapabilities } from "~/capabilities/mod.ts";
import { dispatch as shimDispatch } from "~/capabilities/index.ts";

// Register all capabilities into the internal registry
registerAllCapabilities();

// ---------------------------------------------------------------------------
// Block-based UI renderers
// ---------------------------------------------------------------------------

/**
 * Converts the HTML dashboard to a block-based representation.
 */
function renderDashboardBlocks(state: MonitorState): Block[] {
  // Empty state — no platforms configured
  if (state.github === undefined && state.gitlab === undefined) {
    return renderEmptyStateBlocks();
  }

  const blocks: Block[] = [];

  // Header
  const platformCount =
    (state.github !== undefined ? 1 : 0) +
    (state.gitlab !== undefined ? 1 : 0);
  blocks.push(header("Git Monitor", 2));
  blocks.push(
    text(
      `Monitoring ${platformCount} ${platformCount === 1 ? "platform" : "platforms"}.`,
    ),
  );

  // Platform cards
  const platformCols: Array<{ width?: string; blocks: Block[] }> = [];

  if (state.github !== undefined) {
    platformCols.push({
      blocks: renderPlatformBlocks("GitHub", "github", state.github),
    });
  }
  if (state.gitlab !== undefined) {
    platformCols.push({
      blocks: renderPlatformBlocks("GitLab", "gitlab", state.gitlab),
    });
  }

  if (platformCols.length === 1) {
    blocks.push(section(platformCols[0]!.blocks));
  } else if (platformCols.length === 2) {
    blocks.push(columns(...platformCols));
  }

  blocks.push(divider());

  // Recent events section (empty for now — events are pushed via signals)
  blocks.push(header("Recent Events", 3));
  blocks.push(
    text(
      "No recent events. The monitor will notify you when activity is detected.",
    ),
  );

  blocks.push(divider());

  // Poll interval settings
  blocks.push(header("Poll Interval", 3));
  blocks.push(
    text(
      `How often the monitor checks for new pull requests, CI runs, and alerts. Current: **${state.settings.pollIntervalMinutes} minutes**.`,
    ),
  );
  blocks.push(
    form("poll_interval_form", [
      select(
        "minutes",
        [
          { label: "2 minutes", value: "2" },
          { label: "5 minutes", value: "5" },
          { label: "10 minutes", value: "10" },
          { label: "15 minutes", value: "15" },
          { label: "30 minutes", value: "30" },
        ],
        String(state.settings.pollIntervalMinutes),
      ),
      actions(
        button("Save", {
          execute: "update_poll_interval",
          collect: "poll_interval_form",
          style: "secondary",
        }),
      ),
    ]),
  );

  return blocks;
}

/**
 * Renders blocks for a single platform status card.
 */
function renderPlatformBlocks(
  label: string,
  platform: string,
  platformState: {
    username: string;
    monitoredRepos: string[];
    lastPollAt: string;
    lastError?: string;
    authFailed?: boolean;
  },
): Block[] {
  const blocks: Block[] = [];

  // Status determination
  let statusVariant: "success" | "warning" | "error" = "success";
  let statusLabel = "Connected";
  if (platformState.authFailed === true) {
    statusVariant = "error";
    statusLabel = "Auth Failed";
  } else if (
    platformState.lastError !== undefined &&
    platformState.lastError.length > 0
  ) {
    statusVariant = "warning";
    statusLabel = "Degraded";
  }

  blocks.push(header(`${label}`, 3));
  blocks.push(badge(statusLabel, statusVariant));
  blocks.push(
    keyvalue([
      { key: "Signed in as", value: platformState.username },
      {
        key: "Last polled",
        value: platformState.lastPollAt.length > 0
          ? relativeTime(platformState.lastPollAt)
          : "Never",
      },
    ]),
  );

  // Error banners
  if (
    statusVariant === "warning" &&
    platformState.lastError !== undefined
  ) {
    blocks.push(
      alert(`Last poll error: ${platformState.lastError}`, "warning"),
    );
  }
  if (statusVariant === "error") {
    blocks.push(
      alert(
        "Authentication failed. Your token may have expired or been revoked. Reconnect your account to resume monitoring.",
        "error",
      ),
    );
  }

  // Monitored repos
  blocks.push(
    text(
      `**Monitored repositories** (${platformState.monitoredRepos.length})`,
    ),
  );
  if (platformState.monitoredRepos.length > 0) {
    blocks.push(list(platformState.monitoredRepos));
  } else {
    blocks.push(text("No repositories configured."));
  }

  return blocks;
}

/**
 * Renders the empty state when no platforms are configured.
 */
function renderEmptyStateBlocks(): Block[] {
  return [
    header("Git Monitor", 2),
    text(
      "No platforms are connected yet. Connect a GitHub or GitLab account to start monitoring pull requests, CI pipelines, security alerts, and more.",
    ),
    section(
      [
        header("Get started", 3),
        list([
          "Pull request review requests and merge notifications",
          "CI/CD pipeline failures on protected branches",
          "Dependency and security vulnerability alerts",
          "@mentions in issues, pull requests, and comments",
        ]),
      ],
      undefined,
      false,
    ),
    actions(
      button("Connect a platform", {
        execute: "_setup_wizard",
        style: "primary",
        payload: { step: 1 },
      }),
    ),
  ];
}

/**
 * Renders the setup wizard as blocks.
 */
function renderSetupWizardBlocks(
  step: number,
  platform: string,
): Block[] {
  const blocks: Block[] = [];

  // Step progress
  const steps = ["Platform", "Token", "Validate", "Repositories"];
  const stepItems = steps.map((label, i) => {
    const num = i + 1;
    if (num < step) return `[done] ${label}`;
    if (num === step) return `[current] ${label}`;
    return label;
  });
  blocks.push(text(stepItems.join(" > ")));

  switch (step) {
    case 1:
      blocks.push(header("Connect Your Git Platform", 2));
      blocks.push(text("Choose the platform you want to monitor."));
      blocks.push(
        actions(
          button("GitHub", {
            execute: "_setup_wizard",
            style: "primary",
            payload: { action: "select_platform", platform: "github" },
          }),
          button("GitLab", {
            execute: "_setup_wizard",
            style: "secondary",
            payload: { action: "select_platform", platform: "gitlab" },
          }),
        ),
      );
      break;

    case 2: {
      const isGitHub = platform === "github";
      const platformLabel = isGitHub ? "GitHub" : "GitLab";
      blocks.push(
        header(`${platformLabel} Personal Access Token`, 2),
      );
      blocks.push(
        text(
          "Enter your token below. It is stored securely and will never appear in plain text in any configuration file.",
        ),
      );

      const formBlocks: Block[] = [];

      if (!isGitHub) {
        formBlocks.push(
          input("baseUrl", {
            placeholder: "https://gitlab.com",
            value: "https://gitlab.com",
          }),
        );
      }

      formBlocks.push(
        input("token", {
          placeholder: isGitHub ? "ghp_... or github_pat_..." : "glpat-...",
          type: "password",
        }),
      );

      formBlocks.push(
        actions(
          button("Validate & Save Token", {
            execute: "_setup_wizard",
            collect: "token_form",
            style: "primary",
            payload: { action: "save_token", platform },
          }),
        ),
      );

      blocks.push(form("token_form", formBlocks));

      // Permission hints
      if (isGitHub) {
        blocks.push(
          section(
            [
              text("**Fine-grained PAT (recommended)**"),
              list([
                "Contents: Read",
                "Issues: Read & Write",
                "Pull Requests: Read & Write",
                "Actions (Workflows): Read",
                "Dependabot alerts: Read",
                "Secret scanning alerts: Read",
              ]),
              text("**Classic PAT scopes**"),
              list(["repo", "read:user", "notifications", "security_events"]),
            ],
            "Required token permissions",
            true,
          ),
        );
      } else {
        blocks.push(
          section(
            [
              list([
                "api (full API access including read/write for issues and merge requests)",
              ]),
            ],
            "Required GitLab PAT scopes",
            true,
          ),
        );
      }
      break;
    }

    case 3:
      blocks.push(header("Validating Token...", 2));
      blocks.push(text("Verifying your token with the API. This should take just a moment."));
      break;

    case 4:
      blocks.push(header("Select Repositories", 2));
      blocks.push(text("Loading your repositories..."));
      break;

    default:
      blocks.push(header("Connect Your Git Platform", 2));
      blocks.push(text("Choose the platform you want to monitor."));
      break;
  }

  return blocks;
}

/**
 * Renders step 3 success as blocks.
 */
function renderValidationSuccessBlocks(
  platform: string,
  username: string,
  tokenExpiry: string | null,
): Block[] {
  const platformLabel = platform === "github" ? "GitHub" : "GitLab";
  const blocks: Block[] = [];

  blocks.push(header(`Connected to ${platformLabel}`, 2));
  blocks.push(
    text(
      "Your token was validated and stored securely. Only an opaque reference key is saved.",
    ),
  );

  const pairs: Array<{ key: string; value: string }> = [
    { key: "Signed in as", value: username },
    { key: "Platform", value: platformLabel },
  ];
  if (tokenExpiry) {
    pairs.push({
      key: "Token expiry",
      value: new Date(tokenExpiry).toLocaleDateString(),
    });
  } else {
    pairs.push({ key: "Token expiry", value: "No expiry (non-expiring token)" });
  }
  blocks.push(keyvalue(pairs));

  blocks.push(
    actions(
      button("Choose Repositories", {
        execute: "_setup_wizard",
        style: "primary",
        payload: { action: "load_repos", platform },
      }),
    ),
  );

  return blocks;
}

/**
 * Renders step 4 repo selection as blocks.
 */
function renderRepoSelectionBlocks(
  platform: string,
  repos: Array<{
    id: string;
    fullName: string;
    isPrivate: boolean;
    language?: string;
    description?: string;
  }>,
  alreadySelected: string[],
): Block[] {
  const blocks: Block[] = [];

  blocks.push(header("Select Repositories to Monitor", 2));
  blocks.push(
    text(
      "Choose which repositories you want the monitor to track. You can change this later in settings.",
    ),
  );

  if (repos.length === 0) {
    blocks.push(
      alert(
        "No repositories found. Make sure your token has the correct permissions.",
        "warning",
      ),
    );
  } else {
    const selectedSet = new Set(alreadySelected);
    const headers = ["", "Repository", "Visibility", "Language"];
    const rows = repos.map((repo) => [
      selectedSet.has(repo.fullName) ? "[x]" : "[ ]",
      repo.fullName,
      repo.isPrivate ? "Private" : "Public",
      repo.language ?? "-",
    ]);
    blocks.push(table(headers, rows));

    // Use a form with a text input for comma-separated repos since we
    // don't have checkbox blocks
    blocks.push(
      form("repo_form", [
        input("repos", {
          placeholder: "owner/repo1, owner/repo2, ...",
          value: alreadySelected.join(", "),
        }),
        actions(
          button("Select All", {
            execute: "_setup_wizard",
            style: "secondary",
            payload: {
              action: "select_all",
              platform,
              allRepos: repos.map((r) => r.fullName).join(", "),
            },
          }),
          button("Save & Finish Setup", {
            execute: "_setup_wizard",
            collect: "repo_form",
            style: "primary",
            payload: { action: "save_repos", platform },
          }),
        ),
      ]),
    );
  }

  return blocks;
}

/**
 * Renders setup completion as blocks.
 */
function renderCompleteBlocks(
  platform: string,
  repoCount: number,
): Block[] {
  const platformLabel = platform === "github" ? "GitHub" : "GitLab";
  return [
    header("Setup Complete", 2),
    text(
      `${platformLabel} is connected and ${repoCount} ${repoCount === 1 ? "repository" : "repositories"} will be monitored.`,
    ),
    alert(
      "The monitor will poll for new pull request reviews, CI failures, security alerts, and @mentions every 5 minutes. You can adjust the poll interval and notification preferences in settings at any time.",
      "success",
    ),
  ];
}

// ---------------------------------------------------------------------------
// Relative time helper
// ---------------------------------------------------------------------------

function relativeTime(isoDate: string): string {
  if (!isoDate) return "unknown";
  const ts = Date.parse(isoDate);
  if (Number.isNaN(ts)) return "unknown";

  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "just now";

  const secs = Math.floor(diffMs / 1_000);
  if (secs < 60) return "just now";

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// ---------------------------------------------------------------------------
// Daemon registration
// ---------------------------------------------------------------------------

createDaemon({
  name: "Git Interface",
  version: "1.0.0",
  description:
    "GitHub and GitLab integration — pull requests, issues, CI/CD pipelines, security alerts, code search, and background monitoring",
  author: "Chalie",

  scopes: {
    signals: {
      review_request: "Review requested on a pull/merge request",
      ci_failure: "CI/CD pipeline failure on a key branch",
      ci_recovery: "CI/CD pipeline recovered after failure",
      security_alert: "Security vulnerability alert",
      mention: "User was @mentioned",
      pr_merged: "Pull/merge request was merged",
      pr_closed: "Pull/merge request was closed",
      issue_assigned: "Issue was assigned to user",
      pipeline_trigger: "CI/CD pipeline was triggered",
    },
    messages: {
      review_request: "Review request notification",
      ci_failure: "CI failure notification",
      security_alert: "Security alert notification",
      mention: "Mention notification",
      pr_merged: "PR merge notification",
      issue_assigned: "Issue assignment notification",
    },
  },

  capabilities: [
    {
      name: "repo_list",
      description: "List all repositories accessible to the configured account(s)",
      parameters: [
        { name: "platform", type: "string", description: 'Optional: "github" or "gitlab"', required: false },
      ],
    },
    {
      name: "repo_info",
      description: "Get detailed metadata for a single repository",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
      ],
    },
    {
      name: "pr_list",
      description: "List pull/merge requests. Fans out across all monitored repos when no repo is given",
      parameters: [
        { name: "platform", type: "string", description: 'Optional: "github" or "gitlab"', required: false },
        { name: "repo", type: "string", description: 'Optional: "owner/repo"', required: false },
        { name: "filter", type: "string", description: 'open|closed|merged|mine|review_requested|draft', required: false },
      ],
    },
    {
      name: "pr_get",
      description: "Get detailed information for a single pull/merge request",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
        { name: "number", type: "number", description: "PR/MR number", required: true },
      ],
    },
    {
      name: "pr_create",
      description: "Create a new pull request (GitHub) or merge request (GitLab)",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
        { name: "title", type: "string", description: "PR/MR title", required: true },
        { name: "head", type: "string", description: "Source branch", required: true },
        { name: "base", type: "string", description: "Target branch", required: true },
        { name: "body", type: "string", description: "Description", required: false },
        { name: "draft", type: "boolean", description: "Create as draft", required: false },
      ],
    },
    {
      name: "pr_merge",
      description: "Merge an open pull/merge request",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
        { name: "number", type: "number", description: "PR/MR number", required: true },
        { name: "method", type: "string", description: 'merge|squash|rebase', required: false },
      ],
    },
    {
      name: "pr_review",
      description: "Submit a code review on a pull/merge request",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
        { name: "number", type: "number", description: "PR/MR number", required: true },
        { name: "event", type: "string", description: 'approve|request_changes|comment', required: true },
        { name: "body", type: "string", description: "Review body text", required: false },
      ],
    },
    {
      name: "issue_list",
      description: "List repository issues with optional filters",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
        { name: "filter", type: "string", description: 'open|closed|mine|assigned|all', required: false },
      ],
    },
    {
      name: "issue_create",
      description: "Create a new issue in a repository",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
        { name: "title", type: "string", description: "Issue title", required: true },
        { name: "body", type: "string", description: "Issue description", required: false },
        { name: "labels", type: "string", description: "Comma-separated labels", required: false },
        { name: "assignees", type: "string", description: "Comma-separated usernames (GitHub only)", required: false },
      ],
    },
    {
      name: "issue_update",
      description: "Update an existing issue",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
        { name: "number", type: "number", description: "Issue number", required: true },
        { name: "title", type: "string", description: "New title", required: false },
        { name: "body", type: "string", description: "New description", required: false },
        { name: "state", type: "string", description: 'open|closed', required: false },
        { name: "labels", type: "string", description: "Replacement labels", required: false },
        { name: "assignees", type: "string", description: "Replacement assignees (GitHub only)", required: false },
      ],
    },
    {
      name: "branch_list",
      description: "List all branches in a repository",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
      ],
    },
    {
      name: "pipeline_list",
      description: "List recent CI/CD pipeline or workflow runs",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
        { name: "branch", type: "string", description: "Filter by branch", required: false },
        { name: "status", type: "string", description: "Filter by status", required: false },
      ],
    },
    {
      name: "pipeline_trigger",
      description: "Trigger a new CI/CD pipeline run",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
        { name: "ref", type: "string", description: "Branch or tag ref", required: true },
        { name: "workflow_id", type: "string", description: "Workflow filename (GitHub only)", required: false },
        { name: "inputs", type: "string", description: "JSON key/value inputs", required: false },
      ],
    },
    {
      name: "security_alerts",
      description: "List Dependabot security alerts for a repository (GitHub only)",
      parameters: [
        { name: "platform", type: "string", description: 'Must be "github"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
        { name: "state", type: "string", description: 'open|dismissed|auto_dismissed|fixed', required: false },
      ],
    },
    {
      name: "search",
      description: "Search code across repositories",
      parameters: [
        { name: "platform", type: "string", description: 'Optional: "github" or "gitlab"', required: false },
        { name: "query", type: "string", description: "Search query", required: true },
        { name: "repo", type: "string", description: 'Optional: "owner/repo" scope', required: false },
      ],
    },
    {
      name: "monitor_add",
      description: "Add a repository to the background monitor",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
      ],
    },
    {
      name: "monitor_remove",
      description: "Remove a repository from the background monitor",
      parameters: [
        { name: "platform", type: "string", description: '"github" or "gitlab"', required: true },
        { name: "repo", type: "string", description: '"owner/repo" format', required: true },
      ],
    },
    {
      name: "monitor_status",
      description: "Return monitor configuration summary",
      parameters: [],
    },
  ],

  polls: [],

  async executeCommand(
    capability: string,
    params: Record<string, unknown>,
  ) {
    // Setup wizard actions
    if (capability === "_setup_wizard") {
      try {
        const action = (params.action as string) ?? "";
        const platform = (params.platform as string) ?? "github";
        const step = params.step as number | undefined;

        if (step !== undefined || action === "") {
          return {
            text: null,
            data: null,
            blocks: renderSetupWizardBlocks(step ?? 1, platform),
          };
        }

        if (action === "select_platform") {
          return {
            text: null,
            data: null,
            blocks: renderSetupWizardBlocks(2, platform),
          };
        }

        if (action === "save_token") {
          const token = ((params.token as string) ?? "").trim();
          if (!token) {
            return {
              text: null,
              data: null,
              blocks: [
                alert(
                  "Token is required. Please enter your Personal Access Token.",
                  "error",
                ),
                ...renderSetupWizardBlocks(2, platform),
              ],
            };
          }

          // Validate token
          const baseUrl = platform === "gitlab"
            ? ((params.baseUrl as string) ?? "https://gitlab.com").replace(
                /\/$/,
                "",
              )
            : "https://api.github.com";

          let username = "unknown";
          let tokenExpiry: string | null = null;

          if (platform === "github") {
            const response = await fetch("https://api.github.com/user", {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
            });
            if (response.status === 401) {
              await response.body?.cancel();
              return {
                text: null,
                data: null,
                blocks: [
                  alert(
                    "GitHub token is invalid or has expired. Please check and try again.",
                    "error",
                  ),
                  ...renderSetupWizardBlocks(2, platform),
                ],
              };
            }
            if (!response.ok) {
              await response.body?.cancel();
              return {
                text: null,
                data: null,
                blocks: [
                  alert(
                    `GitHub API returned HTTP ${response.status}.`,
                    "error",
                  ),
                  ...renderSetupWizardBlocks(2, platform),
                ],
              };
            }
            const body = (await response.json()) as { login?: string };
            username = body.login ?? "unknown";
            tokenExpiry =
              response.headers.get(
                "GitHub-Authentication-Token-Expiration",
              );
          } else {
            const url = `${baseUrl}/api/v4/user`;
            const response = await fetch(url, {
              headers: {
                "PRIVATE-TOKEN": token,
                Accept: "application/json",
              },
            });
            if (response.status === 401) {
              await response.body?.cancel();
              return {
                text: null,
                data: null,
                blocks: [
                  alert(
                    "GitLab token is invalid or has expired. Please check and try again.",
                    "error",
                  ),
                  ...renderSetupWizardBlocks(2, platform),
                ],
              };
            }
            if (!response.ok) {
              await response.body?.cancel();
              return {
                text: null,
                data: null,
                blocks: [
                  alert(
                    `GitLab API returned HTTP ${response.status}.`,
                    "error",
                  ),
                  ...renderSetupWizardBlocks(2, platform),
                ],
              };
            }
            const body = (await response.json()) as { username?: string };
            username = body.username ?? "unknown";
          }

          // Store token securely
          const tokenRef = `${platform}_token`;
          await secrets.set(tokenRef, token);

          // Update monitor state
          const state = await loadState();
          const nowIso = new Date().toISOString();

          if (platform === "github") {
            state.github = {
              tokenRef,
              username,
              monitoredRepos: state.github?.monitoredRepos ?? [],
              lastPollAt: state.github?.lastPollAt ?? nowIso,
              seenEventIds: state.github?.seenEventIds ?? [],
            };
          } else {
            state.gitlab = {
              tokenRef,
              baseUrl,
              username,
              monitoredRepos: state.gitlab?.monitoredRepos ?? [],
              lastPollAt: state.gitlab?.lastPollAt ?? nowIso,
              seenEventIds: state.gitlab?.seenEventIds ?? [],
            };
          }
          await saveState(state);

          return {
            text: `Connected to ${platform === "github" ? "GitHub" : "GitLab"} as ${username}`,
            data: null,
            blocks: renderValidationSuccessBlocks(
              platform,
              username,
              tokenExpiry,
            ),
          };
        }

        if (action === "load_repos") {
          const state = await loadState();
          const platformState =
            platform === "github" ? state.github : state.gitlab;
          if (!platformState) {
            return {
              text: null,
              data: null,
              blocks: [
                alert(
                  `No ${platform === "github" ? "GitHub" : "GitLab"} account is connected. Please complete token setup first.`,
                  "error",
                ),
              ],
            };
          }

          const storedToken = await secrets.get(platformState.tokenRef);
          if (!storedToken) {
            return {
              text: null,
              data: null,
              blocks: [
                alert(
                  "Stored token could not be retrieved. Please re-enter your token.",
                  "error",
                ),
              ],
            };
          }

          // Import and use the client functions
          const { listRepos } = await import("~/github/mod.ts");
          const { listProjects } = await import("~/gitlab/mod.ts");

          let repos;
          if (platform === "github") {
            repos = await listRepos(storedToken);
          } else {
            repos = await listProjects(storedToken);
          }

          return {
            text: null,
            data: null,
            blocks: renderRepoSelectionBlocks(
              platform,
              repos,
              platformState.monitoredRepos,
            ),
          };
        }

        if (action === "save_repos") {
          const reposStr = (params.repos as string) ?? "";
          const repos = reposStr
            .split(",")
            .map((r: string) => r.trim())
            .filter((r: string) => r.length > 0);

          const state = await loadState();

          if (platform === "github") {
            if (!state.github) {
              return {
                text: null,
                data: null,
                blocks: [
                  alert(
                    "GitHub account not connected. Please complete token setup.",
                    "error",
                  ),
                ],
              };
            }
            state.github.monitoredRepos = repos;
          } else {
            if (!state.gitlab) {
              return {
                text: null,
                data: null,
                blocks: [
                  alert(
                    "GitLab account not connected. Please complete token setup.",
                    "error",
                  ),
                ],
              };
            }
            state.gitlab.monitoredRepos = repos;
          }

          await saveState(state);

          // Start poller if not already running
          maybeStartPoller(state);

          return {
            text: `Setup complete. Monitoring ${repos.length} repositories on ${platform === "github" ? "GitHub" : "GitLab"}.`,
            data: null,
            blocks: renderCompleteBlocks(platform, repos.length),
          };
        }

        if (action === "select_all") {
          const allRepos = (params.allRepos as string) ?? "";
          return {
            text: null,
            data: null,
            blocks: renderRepoSelectionBlocks(
              platform,
              [], // repos already shown
              allRepos.split(",").map((r: string) => r.trim()).filter((r: string) => r.length > 0),
            ),
          };
        }

        return {
          text: `Unknown setup action: ${action}`,
          data: null,
          error: `Unknown setup action: ${action}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          text: msg,
          data: null,
          blocks: [alert(msg, "error")],
        };
      }
    }

    // Poll interval update
    if (capability === "update_poll_interval") {
      try {
        const minutes = Number(params.minutes ?? 5);
        const state = await loadState();
        state.settings.pollIntervalMinutes = Math.max(
          2,
          Math.min(30, minutes),
        );
        await saveState(state);
        return {
          text: `Poll interval updated to ${state.settings.pollIntervalMinutes} minutes.`,
          data: null,
          blocks: renderDashboardBlocks(state),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { text: msg, data: null, error: msg };
      }
    }

    // Dispatch to existing capability handlers via the shim registry
    try {
      const result = await shimDispatch(capability, params);

      if (result.error !== undefined) {
        return { text: result.error, data: null, error: result.error };
      }

      return {
        text: result.text ?? null,
        html: result.html,
        data: null,
      };
    } catch (err) {
      if (err instanceof ApiError) {
        const msg = `[${err.platform}] ${err.message}`;
        return { text: msg, data: null, error: msg };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { text: msg, data: null, error: msg };
    }
  },

  async renderInterface(): Promise<Block[]> {
    const state = await loadState();

    if (state.github === undefined && state.gitlab === undefined) {
      return renderEmptyStateBlocks();
    }

    return renderDashboardBlocks(state);
  },
});
