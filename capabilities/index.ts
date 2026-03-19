/**
 * @module capabilities/index
 *
 * Registers all 18 Chalie Git Interface capabilities with the SDK shim
 * dispatcher. Each handler:
 *
 *  1. Loads the current monitor state via `loadState()`.
 *  2. Retrieves the real API token from the secure secrets store via
 *     `secrets.get(state[platform].tokenRef)` — never from `monitor.json`.
 *  3. Delegates to the appropriate GitHub or GitLab client function.
 *  4. Returns `{ title, text }` (indented JSON) on success, or `{ error }`
 *     on failure.
 *
 * ### Token security
 * Raw token values are **never** read from `monitor.json` or any other
 * plaintext file. The `tokenRef` stored in monitor state is an opaque key
 * that is passed to `secrets.get()` to look up the real credential at
 * runtime.
 *
 * ### Fan-out
 * `pr_list` (without `repo`) and `repo_list` (without `platform`) fan out
 * across all monitored repositories using at most {@link FAN_OUT_CONCURRENCY}
 * concurrent API requests. Individual repository failures are silently
 * skipped so one inaccessible repo does not prevent results from the others.
 *
 * ### GitLab notes
 * - Security alerts (`security_alerts`) are GitHub-only; calling this
 *   capability with `platform: "gitlab"` returns an explanatory error.
 * - `pr_review` with `event: "approve"` or `event: "request_changes"` on
 *   GitLab is not natively supported; only `event: "comment"` is available
 *   (mapped to an MR note). Approve/changes-requested events return an
 *   explanatory error for GitLab.
 * - GitLab code search is project-scoped; when `repo` is omitted the
 *   capability iterates up to {@link GITLAB_SEARCH_MAX_REPOS} monitored
 *   projects.
 *
 * @example
 * ```ts
 * import { registerAllCapabilities } from "~/capabilities/index.ts";
 * registerAllCapabilities();
 * ```
 */

import { registerCapability, secrets } from "@chalie/interface-sdk";
import type { CapabilityContext, CapabilityResult } from "@chalie/interface-sdk";
import { loadState, saveState } from "~/monitor/store.ts";
import type { GitHubPlatformState, GitLabPlatformState, MonitorState } from "~/monitor/store.ts";
import {
  createIssue as ghCreateIssue,
  createPR as ghCreatePR,
  createReview as ghCreateReview,
  getPR as ghGetPR,
  getRepo as ghGetRepo,
  listBranches as ghListBranches,
  listIssues as ghListIssues,
  listPRs as ghListPRs,
  listRepos as ghListRepos,
  listSecurityAlerts as ghListSecurityAlerts,
  listWorkflowRuns as ghListWorkflowRuns,
  mergePR as ghMergePR,
  searchCode as ghSearchCode,
  triggerWorkflow as ghTriggerWorkflow,
  updateIssue as ghUpdateIssue,
} from "~/github/mod.ts";
import {
  createIssue as glCreateIssue,
  createMR as glCreateMR,
  createMRNote as glCreateMRNote,
  encodeProjectPath,
  getMR as glGetMR,
  getProject as glGetProject,
  listBranches as glListBranches,
  listIssues as glListIssues,
  listMRs as glListMRs,
  listPipelines as glListPipelines,
  listProjects as glListProjects,
  mergeMR as glMergeMR,
  searchCode as glSearchCode,
  triggerPipeline as glTriggerPipeline,
  updateIssue as glUpdateIssue,
} from "~/gitlab/mod.ts";
import { ApiError } from "~/shared/mod.ts";
import type {
  Branch,
  CodeResult,
  Pipeline,
  PullRequest,
  Repo,
  SecurityAlert,
} from "~/shared/mod.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum concurrent API calls during fan-out operations. */
const FAN_OUT_CONCURRENCY = 5;

/**
 * Maximum number of GitLab projects to search when `repo` is omitted in the
 * `search` capability. GitLab code search is project-scoped, so we iterate
 * monitored projects up to this limit.
 */
const GITLAB_SEARCH_MAX_REPOS = 10;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Splits a `"owner/repo"` full name into a `[owner, repo]` tuple.
 *
 * @param fullName - Repository full name in `"owner/repo"` format.
 * @returns A two-element tuple `[owner, repo]`.
 * @throws {Error} If `fullName` does not contain a `/` separator.
 */
function splitRepo(fullName: string): [string, string] {
  const idx = fullName.indexOf("/");
  if (idx === -1) {
    throw new Error(
      `Invalid repository path "${fullName}": expected "owner/repo" format.`,
    );
  }
  return [fullName.slice(0, idx), fullName.slice(idx + 1)];
}

/**
 * Converts an unknown thrown value into a `{ error }` capability result.
 *
 * `ApiError` instances are formatted with a `[platform]` prefix for context.
 * Plain `Error` objects use their `.message`. Everything else is stringified.
 *
 * @param err - The caught value.
 * @returns A `CapabilityResult` with only the `error` field populated.
 */
function formatError(err: unknown): CapabilityResult {
  if (err instanceof ApiError) {
    return { error: `[${err.platform}] ${err.message}` };
  }
  if (err instanceof Error) {
    return { error: err.message };
  }
  return { error: String(err) };
}

/**
 * Wraps a JSON-serialisable value as a successful capability result.
 *
 * @param data - Any JSON-serialisable value to include in the response body.
 * @param title - Short title shown in the Chalie capability result panel.
 * @returns `{ title, text }` with `data` serialised as indented JSON.
 */
function ok(data: unknown, title: string): CapabilityResult {
  return { title, text: JSON.stringify(data, null, 2) };
}

/**
 * Asserts that GitHub is configured and retrieves its PAT via the secrets
 * store.
 *
 * The token is fetched via `secrets.get(state.github.tokenRef)`. The raw
 * token value is never stored in `monitor.json`.
 *
 * @param state - Current monitor state.
 * @returns `{ token, ghState }` when GitHub is configured and the token is
 *   available.
 * @throws {Error} If GitHub is not configured or the token cannot be found.
 */
async function requireGitHub(
  state: MonitorState,
): Promise<{ token: string; ghState: GitHubPlatformState }> {
  if (state.github === undefined) {
    throw new Error(
      "GitHub is not configured. Connect your GitHub account in Monitor settings first.",
    );
  }
  const token = await secrets.get(state.github.tokenRef);
  if (token === null) {
    throw new Error(
      "GitHub token not found in the secrets store. Please reconnect your GitHub account.",
    );
  }
  return { token, ghState: state.github };
}

/**
 * Asserts that GitLab is configured and retrieves its PAT via the secrets
 * store.
 *
 * The token is fetched via `secrets.get(state.gitlab.tokenRef)`. The raw
 * token value is never stored in `monitor.json`.
 *
 * @param state - Current monitor state.
 * @returns `{ token, glState }` when GitLab is configured and the token is
 *   available.
 * @throws {Error} If GitLab is not configured or the token cannot be found.
 */
async function requireGitLab(
  state: MonitorState,
): Promise<{ token: string; glState: GitLabPlatformState }> {
  if (state.gitlab === undefined) {
    throw new Error(
      "GitLab is not configured. Connect your GitLab account in Monitor settings first.",
    );
  }
  const token = await secrets.get(state.gitlab.tokenRef);
  if (token === null) {
    throw new Error(
      "GitLab token not found in the secrets store. Please reconnect your GitLab account.",
    );
  }
  return { token, glState: state.gitlab };
}

/**
 * Fans out an async list operation over a set of string items with bounded
 * concurrency.
 *
 * Items are processed in batches of at most `concurrency`. Rejected promises
 * within a batch are silently discarded so a single item failure does not
 * abort the rest.
 *
 * @param items - The input items to process.
 * @param concurrency - Maximum number of items to process simultaneously.
 * @param fn - Async function invoked for each item; returns an array.
 * @returns A flat array containing all results from fulfilled promises.
 */
async function fanOut<T>(
  items: readonly string[],
  concurrency: number,
  fn: (item: string) => Promise<T[]>,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(...result.value);
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// repo_list
// ---------------------------------------------------------------------------

/**
 * Handler for the `repo_list` capability.
 *
 * Lists all repositories accessible to the authenticated account(s). When
 * `platform` is omitted both GitHub and GitLab are queried; failures on one
 * platform are silently skipped.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Optional `"github"` or `"gitlab"` filter.
 * @returns Serialised `Repo[]` on success, or `{ error }` on failure.
 */
async function handleRepoList(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;

  try {
    const state = await loadState();
    const repos: Repo[] = [];

    if (platform === undefined || platform === "github") {
      try {
        const { token } = await requireGitHub(state);
        repos.push(...(await ghListRepos(token)));
      } catch (err) {
        if (platform === "github") throw err;
        // Both platforms requested — skip unconfigured platform silently.
      }
    }

    if (platform === undefined || platform === "gitlab") {
      try {
        const { token } = await requireGitLab(state);
        repos.push(...(await glListProjects(token)));
      } catch (err) {
        if (platform === "gitlab") throw err;
      }
    }

    return ok(repos, `Repositories (${repos.length})`);
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// repo_info
// ---------------------------------------------------------------------------

/**
 * Handler for the `repo_info` capability.
 *
 * Returns detailed metadata for a single repository.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @returns Serialised `Repo` on success, or `{ error }` on failure.
 */
async function handleRepoInfo(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };

  try {
    const state = await loadState();

    if (platform === "github") {
      const { token } = await requireGitHub(state);
      const [owner, repoName] = splitRepo(repoParam);
      const repo = await ghGetRepo(token, owner, repoName);
      return ok(repo, repo.fullName);
    }

    if (platform === "gitlab") {
      const { token } = await requireGitLab(state);
      const repo = await glGetProject(token, encodeProjectPath(repoParam));
      return ok(repo, repo.fullName);
    }

    return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// pr_list
// ---------------------------------------------------------------------------

/**
 * Handler for the `pr_list` capability.
 *
 * Lists pull requests (GitHub) or merge requests (GitLab). When `repo` is
 * omitted the capability fans out across all monitored repositories with at
 * most {@link FAN_OUT_CONCURRENCY} concurrent API calls.
 *
 * ### Filter semantics
 * | `filter` value | Behaviour |
 * |---|---|
 * | `"open"` (default) | Open PRs (includes drafts) |
 * | `"closed"` | Closed PRs |
 * | `"merged"` | Merged PRs |
 * | `"mine"` | All PRs authored by the authenticated user |
 * | `"review_requested"` | Open PRs where authenticated user is a requested reviewer |
 * | `"draft"` | Open draft PRs only |
 *
 * `"mine"`, `"review_requested"`, and `"draft"` are applied as client-side
 * filters after fetching from the API.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Optional `"github"` or `"gitlab"` filter.
 *   Required when `repo` is provided.
 * @param ctx.params.repo - Optional `"owner/repo"`. When absent the capability
 *   fans out over all monitored repos on the requested platform(s).
 * @param ctx.params.filter - Optional filter string (see table above).
 * @returns Serialised `PullRequest[]` on success, or `{ error }` on failure.
 */
async function handlePrList(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;
  const filter = (ctx.params["filter"] as string | undefined) ?? "open";

  if (repoParam !== undefined && platform === undefined) {
    return {
      error: 'Parameter "platform" is required when "repo" is specified.',
    };
  }

  try {
    const state = await loadState();
    const prs: PullRequest[] = [];

    // --- GitHub ---
    if (platform === undefined || platform === "github") {
      try {
        const { token, ghState } = await requireGitHub(state);

        const fetchFromRepo = async (fullName: string): Promise<PullRequest[]> => {
          const [owner, repo] = splitRepo(fullName);

          // Map capability filter to the GitHub API `state` parameter.
          let apiState: "open" | "closed" | "all" = "open";
          if (filter === "closed") {
            apiState = "closed";
          } else if (filter === "merged") {
            // GitHub merged PRs have state="closed" in the API; we filter
            // client-side on the normalised `state === "merged"`.
            apiState = "closed";
          } else if (filter === "mine") {
            apiState = "all";
          }

          let fetched = await ghListPRs(token, owner, repo, { state: apiState });

          // Apply client-side post-filters.
          if (filter === "merged") {
            fetched = fetched.filter((pr) => pr.state === "merged");
          } else if (filter === "mine") {
            fetched = fetched.filter((pr) => pr.author === ghState.username);
          } else if (filter === "review_requested") {
            fetched = fetched.filter((pr) => pr.reviewers.includes(ghState.username));
          } else if (filter === "draft") {
            fetched = fetched.filter((pr) => pr.isDraft);
          }

          return fetched;
        };

        const repos = repoParam !== undefined ? [repoParam] : ghState.monitoredRepos;
        prs.push(...(await fanOut(repos, FAN_OUT_CONCURRENCY, fetchFromRepo)));
      } catch (err) {
        if (platform === "github") throw err;
        // Both platforms requested — skip unconfigured platform silently.
      }
    }

    // --- GitLab ---
    if (platform === undefined || platform === "gitlab") {
      try {
        const { token, glState } = await requireGitLab(state);

        const fetchFromRepo = async (fullName: string): Promise<PullRequest[]> => {
          const projectId = encodeProjectPath(fullName);

          // Map capability filter to the GitLab API `state` parameter.
          let apiState: "opened" | "closed" | "merged" | "all" = "opened";
          if (filter === "closed") {
            apiState = "closed";
          } else if (filter === "merged") {
            apiState = "merged";
          } else if (filter === "mine") {
            apiState = "all";
          }

          let fetched = await glListMRs(token, projectId, { state: apiState });

          // Apply client-side post-filters.
          if (filter === "mine") {
            fetched = fetched.filter((pr) => pr.author === glState.username);
          } else if (filter === "review_requested") {
            fetched = fetched.filter((pr) => pr.reviewers.includes(glState.username));
          } else if (filter === "draft") {
            fetched = fetched.filter((pr) => pr.isDraft);
          }

          return fetched;
        };

        const repos = repoParam !== undefined ? [repoParam] : glState.monitoredRepos;
        prs.push(...(await fanOut(repos, FAN_OUT_CONCURRENCY, fetchFromRepo)));
      } catch (err) {
        if (platform === "gitlab") throw err;
      }
    }

    return ok(prs, `Pull Requests (${prs.length})`);
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// pr_get
// ---------------------------------------------------------------------------

/**
 * Handler for the `pr_get` capability.
 *
 * Returns detailed information for a single pull or merge request.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @param ctx.params.number - Required. PR/MR number (integer).
 * @returns Serialised `PullRequest` on success, or `{ error }` on failure.
 */
async function handlePrGet(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;
  const number = ctx.params["number"] as number | undefined;

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };
  if (number === undefined) return { error: 'Parameter "number" is required.' };

  try {
    const state = await loadState();

    if (platform === "github") {
      const { token } = await requireGitHub(state);
      const [owner, repo] = splitRepo(repoParam);
      const pr = await ghGetPR(token, owner, repo, number);
      return ok(pr, `PR #${pr.number}: ${pr.title}`);
    }

    if (platform === "gitlab") {
      const { token } = await requireGitLab(state);
      const pr = await glGetMR(token, encodeProjectPath(repoParam), number);
      return ok(pr, `MR !${pr.number}: ${pr.title}`);
    }

    return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// pr_create
// ---------------------------------------------------------------------------

/**
 * Handler for the `pr_create` capability.
 *
 * Creates a new pull request (GitHub) or merge request (GitLab).
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @param ctx.params.title - Required. PR/MR title.
 * @param ctx.params.head - Required. Source branch name.
 * @param ctx.params.base - Required. Target branch name.
 * @param ctx.params.body - Optional. PR/MR description.
 * @param ctx.params.draft - Optional. Whether to create as a draft.
 * @returns Serialised `PullRequest` on success, or `{ error }` on failure.
 */
async function handlePrCreate(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;
  const title = ctx.params["title"] as string | undefined;
  const head = ctx.params["head"] as string | undefined;
  const base = ctx.params["base"] as string | undefined;
  const body = ctx.params["body"] as string | undefined;
  const draft = ctx.params["draft"] as boolean | undefined;

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };
  if (title === undefined) return { error: 'Parameter "title" is required.' };
  if (head === undefined) return { error: 'Parameter "head" is required.' };
  if (base === undefined) return { error: 'Parameter "base" is required.' };

  try {
    const state = await loadState();

    if (platform === "github") {
      const { token } = await requireGitHub(state);
      const [owner, repo] = splitRepo(repoParam);
      const params: { title: string; head: string; base: string; body?: string; draft?: boolean } =
        { title, head, base };
      if (body !== undefined) params.body = body;
      if (draft !== undefined) params.draft = draft;
      const pr = await ghCreatePR(token, owner, repo, params);
      return ok(pr, `Created PR #${pr.number}: ${pr.title}`);
    }

    if (platform === "gitlab") {
      const { token } = await requireGitLab(state);
      const params: {
        title: string;
        sourceBranch: string;
        targetBranch: string;
        description?: string;
        draft?: boolean;
      } = { title, sourceBranch: head, targetBranch: base };
      if (body !== undefined) params.description = body;
      if (draft !== undefined) params.draft = draft;
      const pr = await glCreateMR(token, encodeProjectPath(repoParam), params);
      return ok(pr, `Created MR !${pr.number}: ${pr.title}`);
    }

    return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// pr_merge
// ---------------------------------------------------------------------------

/**
 * Handler for the `pr_merge` capability.
 *
 * Merges an open pull or merge request.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @param ctx.params.number - Required. PR/MR number.
 * @param ctx.params.method - Optional merge method: `"merge"` (default),
 *   `"squash"`, or `"rebase"`. On GitLab only `"merge"` and `"squash"` are
 *   supported; `"rebase"` is treated as `"merge"`.
 * @returns Confirmation text on success, or `{ error }` on failure.
 */
async function handlePrMerge(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;
  const number = ctx.params["number"] as number | undefined;
  const method = (ctx.params["method"] as string | undefined) ?? "merge";

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };
  if (number === undefined) return { error: 'Parameter "number" is required.' };

  try {
    const state = await loadState();

    if (platform === "github") {
      const { token } = await requireGitHub(state);
      const [owner, repo] = splitRepo(repoParam);
      const mergeMethod = method === "squash" || method === "rebase"
        ? (method as "squash" | "rebase")
        : "merge";
      await ghMergePR(token, owner, repo, number, { mergeMethod });
      return { title: "Merged", text: `PR #${number} in ${repoParam} was merged successfully.` };
    }

    if (platform === "gitlab") {
      const { token } = await requireGitLab(state);
      const squash = method === "squash";
      await glMergeMR(token, encodeProjectPath(repoParam), number, { squash });
      return {
        title: "Merged",
        text: `MR !${number} in ${repoParam} was merged successfully.`,
      };
    }

    return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// pr_review
// ---------------------------------------------------------------------------

/**
 * Handler for the `pr_review` capability.
 *
 * Submits a code review on a pull or merge request.
 *
 * On **GitHub**, all three event types are supported: `"approve"`,
 * `"request_changes"`, and `"comment"`.
 *
 * On **GitLab**, only `"comment"` is supported (posted as an MR note).
 * `"approve"` and `"request_changes"` return an explanatory error because
 * GitLab's approval model does not map to these events via the PAT API.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @param ctx.params.number - Required. PR/MR number.
 * @param ctx.params.event - Required. `"approve"`, `"request_changes"`, or
 *   `"comment"`.
 * @param ctx.params.body - Optional review body text.
 * @returns Serialised `Review` (GitHub) or `Comment` (GitLab comment) on
 *   success, or `{ error }` on failure.
 */
async function handlePrReview(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;
  const number = ctx.params["number"] as number | undefined;
  const event = ctx.params["event"] as string | undefined;
  const body = ctx.params["body"] as string | undefined;

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };
  if (number === undefined) return { error: 'Parameter "number" is required.' };
  if (event === undefined) return { error: 'Parameter "event" is required.' };

  try {
    const state = await loadState();

    if (platform === "github") {
      if (
        event !== "approve" &&
        event !== "request_changes" &&
        event !== "comment"
      ) {
        return {
          error: `Invalid event "${event}". Use "approve", "request_changes", or "comment".`,
        };
      }
      const { token } = await requireGitHub(state);
      const [owner, repo] = splitRepo(repoParam);
      const params: { event: "approve" | "request_changes" | "comment"; body?: string } = {
        event,
      };
      if (body !== undefined) params.body = body;
      const review = await ghCreateReview(token, owner, repo, number, params);
      return ok(review, `Review submitted on PR #${number}`);
    }

    if (platform === "gitlab") {
      if (event === "approve" || event === "request_changes") {
        return {
          error: `GitLab does not support "${event}" reviews via the PAT API. ` +
            `Only "comment" (MR notes) is supported. Use the GitLab web UI to approve.`,
        };
      }
      if (event !== "comment") {
        return {
          error: `Invalid event "${event}". For GitLab, use "comment".`,
        };
      }
      const noteBody = body ?? "";
      if (noteBody === "") return { error: 'Parameter "body" is required for GitLab comments.' };
      const { token } = await requireGitLab(state);
      const comment = await glCreateMRNote(
        token,
        encodeProjectPath(repoParam),
        number,
        noteBody,
      );
      return ok(comment, `Comment posted on MR !${number}`);
    }

    return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// issue_list
// ---------------------------------------------------------------------------

/**
 * Handler for the `issue_list` capability.
 *
 * Lists repository issues with optional state and ownership filters.
 *
 * ### Filter semantics
 * | `filter` value | GitHub | GitLab |
 * |---|---|---|
 * | `"open"` (default) | `state=open` | `state=opened` |
 * | `"closed"` | `state=closed` | `state=closed` |
 * | `"mine"` | `filter=created` (authored by me) | `author_username=<username>` |
 * | `"assigned"` | `filter=assigned` (assigned to me) | `assignee_username=<username>` |
 * | `"all"` | `state=all` | `state=all` |
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @param ctx.params.filter - Optional. See filter table above.
 * @returns Serialised `Issue[]` on success, or `{ error }` on failure.
 */
async function handleIssueList(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;
  const filter = (ctx.params["filter"] as string | undefined) ?? "open";

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };

  try {
    const state = await loadState();

    if (platform === "github") {
      const { token } = await requireGitHub(state);
      const [owner, repo] = splitRepo(repoParam);

      let ghState_val: "open" | "closed" | "all" = "open";
      let ghFilter: "assigned" | "created" | "mentioned" | undefined;

      if (filter === "closed") {
        ghState_val = "closed";
      } else if (filter === "all") {
        ghState_val = "all";
      } else if (filter === "mine") {
        // "mine" = authored by authenticated user
        ghFilter = "created";
      } else if (filter === "assigned") {
        ghFilter = "assigned";
      }

      const opts: {
        state?: "open" | "closed" | "all";
        filter?: "assigned" | "created" | "mentioned";
      } = { state: ghState_val };
      if (ghFilter !== undefined) opts.filter = ghFilter;

      // For "mine"/"assigned" the GitHub API filters server-side via the
      // `filter` parameter — no client-side username comparison needed.
      const issues = await ghListIssues(token, owner, repo, opts);

      return ok(issues, `Issues (${issues.length})`);
    }

    if (platform === "gitlab") {
      const { token, glState } = await requireGitLab(state);
      const projectId = encodeProjectPath(repoParam);

      let glStateParam: "opened" | "closed" | "all" = "opened";
      let assigneeUsername: string | undefined;
      let authorUsername: string | undefined;

      if (filter === "closed") {
        glStateParam = "closed";
      } else if (filter === "all") {
        glStateParam = "all";
      } else if (filter === "mine") {
        // "mine" = authored by authenticated user
        authorUsername = glState.username;
      } else if (filter === "assigned") {
        assigneeUsername = glState.username;
      }

      const opts: {
        state?: "opened" | "closed" | "all";
        assigneeUsername?: string;
        authorUsername?: string;
      } = { state: glStateParam };
      if (assigneeUsername !== undefined) opts.assigneeUsername = assigneeUsername;
      if (authorUsername !== undefined) opts.authorUsername = authorUsername;

      const issues = await glListIssues(token, projectId, opts);
      return ok(issues, `Issues (${issues.length})`);
    }

    return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// issue_create
// ---------------------------------------------------------------------------

/**
 * Handler for the `issue_create` capability.
 *
 * Creates a new issue in the specified repository.
 *
 * **GitLab note:** Assignees are identified by numeric user IDs on GitLab,
 * but this capability accepts usernames. GitLab assignee IDs are not
 * supported here; use the GitLab web UI to assign issues by username.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @param ctx.params.title - Required. Issue title.
 * @param ctx.params.body - Optional. Issue description.
 * @param ctx.params.labels - Optional. Array of label names.
 * @param ctx.params.assignees - Optional. Array of usernames (GitHub only).
 * @returns Serialised `Issue` on success, or `{ error }` on failure.
 */
async function handleIssueCreate(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;
  const title = ctx.params["title"] as string | undefined;
  const body = ctx.params["body"] as string | undefined;
  const labels = ctx.params["labels"] as string[] | undefined;
  const assignees = ctx.params["assignees"] as string[] | undefined;

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };
  if (title === undefined) return { error: 'Parameter "title" is required.' };

  try {
    const state = await loadState();

    if (platform === "github") {
      const { token } = await requireGitHub(state);
      const [owner, repo] = splitRepo(repoParam);
      const params: {
        title: string;
        body?: string;
        labels?: string[];
        assignees?: string[];
      } = { title };
      if (body !== undefined) params.body = body;
      if (labels !== undefined) params.labels = labels;
      if (assignees !== undefined) params.assignees = assignees;
      const issue = await ghCreateIssue(token, owner, repo, params);
      return ok(issue, `Created issue #${issue.number}: ${issue.title}`);
    }

    if (platform === "gitlab") {
      const { token } = await requireGitLab(state);
      const params: { title: string; description?: string; labels?: string[] } = { title };
      if (body !== undefined) params.description = body;
      if (labels !== undefined) params.labels = labels;
      // GitLab assignees use numeric IDs; username-based assignment is not
      // supported here.
      const issue = await glCreateIssue(token, encodeProjectPath(repoParam), params);
      return ok(issue, `Created issue #${issue.number}: ${issue.title}`);
    }

    return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// issue_update
// ---------------------------------------------------------------------------

/**
 * Handler for the `issue_update` capability.
 *
 * Updates an existing issue. Only supplied fields are modified.
 *
 * **GitLab note:** Assignees use numeric user IDs on GitLab, so the
 * `assignees` parameter is supported only for GitHub. On GitLab, supply
 * only `title`, `body`, `state`, and `labels`.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @param ctx.params.number - Required. Issue number.
 * @param ctx.params.title - Optional. New title.
 * @param ctx.params.body - Optional. New description.
 * @param ctx.params.state - Optional. `"open"` or `"closed"`.
 * @param ctx.params.labels - Optional. Replacement label list.
 * @param ctx.params.assignees - Optional. Replacement assignee list
 *   (usernames; GitHub only).
 * @returns Serialised updated `Issue` on success, or `{ error }` on failure.
 */
async function handleIssueUpdate(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;
  const number = ctx.params["number"] as number | undefined;
  const title = ctx.params["title"] as string | undefined;
  const body = ctx.params["body"] as string | undefined;
  const issueState = ctx.params["state"] as string | undefined;
  const labels = ctx.params["labels"] as string[] | undefined;
  const assignees = ctx.params["assignees"] as string[] | undefined;

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };
  if (number === undefined) return { error: 'Parameter "number" is required.' };

  try {
    const state = await loadState();

    if (platform === "github") {
      const { token } = await requireGitHub(state);
      const [owner, repo] = splitRepo(repoParam);
      const params: {
        title?: string;
        body?: string;
        state?: "open" | "closed";
        labels?: string[];
        assignees?: string[];
      } = {};
      if (title !== undefined) params.title = title;
      if (body !== undefined) params.body = body;
      if (issueState === "open" || issueState === "closed") params.state = issueState;
      if (labels !== undefined) params.labels = labels;
      if (assignees !== undefined) params.assignees = assignees;
      const issue = await ghUpdateIssue(token, owner, repo, number, params);
      return ok(issue, `Updated issue #${issue.number}: ${issue.title}`);
    }

    if (platform === "gitlab") {
      const { token } = await requireGitLab(state);
      const params: {
        title?: string;
        description?: string;
        state?: "close" | "reopen";
        labels?: string[];
      } = {};
      if (title !== undefined) params.title = title;
      if (body !== undefined) params.description = body;
      // Map "open"/"closed" to GitLab's state_event values.
      if (issueState === "open") params.state = "reopen";
      else if (issueState === "closed") params.state = "close";
      if (labels !== undefined) params.labels = labels;
      const issue = await glUpdateIssue(
        token,
        encodeProjectPath(repoParam),
        number,
        params,
      );
      return ok(issue, `Updated issue #${issue.number}: ${issue.title}`);
    }

    return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// branch_list
// ---------------------------------------------------------------------------

/**
 * Handler for the `branch_list` capability.
 *
 * Lists all branches in the specified repository.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @returns Serialised `Branch[]` on success, or `{ error }` on failure.
 */
async function handleBranchList(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };

  try {
    const state = await loadState();
    let branches: Branch[];

    if (platform === "github") {
      const { token } = await requireGitHub(state);
      const [owner, repo] = splitRepo(repoParam);
      branches = await ghListBranches(token, owner, repo);
    } else if (platform === "gitlab") {
      const { token } = await requireGitLab(state);
      branches = await glListBranches(token, encodeProjectPath(repoParam));
    } else {
      return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
    }

    return ok(branches, `Branches in ${repoParam} (${branches.length})`);
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// pipeline_list
// ---------------------------------------------------------------------------

/**
 * Handler for the `pipeline_list` capability.
 *
 * Lists recent CI/CD pipeline or workflow runs for a repository.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @param ctx.params.branch - Optional. Filter by branch name.
 * @param ctx.params.status - Optional. Filter by status string.
 * @returns Serialised `Pipeline[]` on success, or `{ error }` on failure.
 */
async function handlePipelineList(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;
  const branch = ctx.params["branch"] as string | undefined;
  const status = ctx.params["status"] as string | undefined;

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };

  try {
    const state = await loadState();
    let pipelines: Pipeline[];

    if (platform === "github") {
      const { token } = await requireGitHub(state);
      const [owner, repo] = splitRepo(repoParam);
      const opts: { branch?: string; status?: string } = {};
      if (branch !== undefined) opts.branch = branch;
      if (status !== undefined) opts.status = status;
      pipelines = await ghListWorkflowRuns(token, owner, repo, opts);
    } else if (platform === "gitlab") {
      const { token } = await requireGitLab(state);
      const opts: { ref?: string; status?: string } = {};
      if (branch !== undefined) opts.ref = branch;
      if (status !== undefined) opts.status = status;
      pipelines = await glListPipelines(token, encodeProjectPath(repoParam), opts);
    } else {
      return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
    }

    return ok(pipelines, `Pipelines in ${repoParam} (${pipelines.length})`);
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// pipeline_trigger
// ---------------------------------------------------------------------------

/**
 * Handler for the `pipeline_trigger` capability.
 *
 * Triggers a new CI/CD pipeline or workflow run.
 *
 * - **GitHub**: Uses `workflow_dispatch` to trigger a named workflow file.
 *   `workflow_id` (e.g. `"ci.yml"`) is required.
 * - **GitLab**: Triggers a pipeline on the specified branch. `workflow_id`
 *   is ignored.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @param ctx.params.ref - Required. Branch or tag ref to run against.
 * @param ctx.params.workflow_id - Required for GitHub. Workflow filename
 *   (e.g. `"ci.yml"`). Ignored for GitLab.
 * @param ctx.params.inputs - Optional. Key/value map of workflow inputs
 *   (GitHub) or CI variables (GitLab).
 * @returns Confirmation text (GitHub) or serialised `Pipeline` (GitLab) on
 *   success, or `{ error }` on failure.
 */
async function handlePipelineTrigger(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;
  const ref = ctx.params["ref"] as string | undefined;
  const workflowId = ctx.params["workflow_id"] as string | undefined;
  const inputs = ctx.params["inputs"] as Record<string, string> | undefined;

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };
  if (ref === undefined) return { error: 'Parameter "ref" is required.' };

  try {
    const state = await loadState();

    if (platform === "github") {
      if (workflowId === undefined) {
        return {
          error: 'Parameter "workflow_id" is required for GitHub. ' +
            'Provide the workflow filename (e.g. "ci.yml").',
        };
      }
      const { token } = await requireGitHub(state);
      const [owner, repo] = splitRepo(repoParam);
      await ghTriggerWorkflow(token, owner, repo, workflowId, ref, inputs);
      return {
        title: "Workflow triggered",
        text: `Workflow "${workflowId}" dispatched on ${repoParam} @ ${ref}. ` +
          `Check the Actions tab for progress.`,
      };
    }

    if (platform === "gitlab") {
      const { token } = await requireGitLab(state);
      const pipeline = await glTriggerPipeline(
        token,
        encodeProjectPath(repoParam),
        ref,
        inputs,
      );
      return ok(pipeline, `Pipeline triggered on ${repoParam} @ ${ref}`);
    }

    return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// security_alerts
// ---------------------------------------------------------------------------

/**
 * Handler for the `security_alerts` capability.
 *
 * Lists Dependabot security alerts for a GitHub repository.
 *
 * **GitHub only.** GitLab's vulnerability scanning does not have an
 * equivalent endpoint exposed by this client; passing `platform: "gitlab"`
 * returns an explanatory error.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. Must be `"github"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @param ctx.params.state - Optional. Alert state filter: `"open"` (default),
 *   `"dismissed"`, `"auto_dismissed"`, or `"fixed"`.
 * @returns Serialised `SecurityAlert[]` on success, or `{ error }` on failure.
 */
async function handleSecurityAlerts(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;
  const alertState = ctx.params["state"] as string | undefined;

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };

  if (platform === "gitlab") {
    return {
      error: "Security alerts are only available for GitHub repositories. " +
        "GitLab vulnerability scanning is not supported by this capability.",
    };
  }

  if (platform !== "github") {
    return { error: `Unknown platform "${platform}". Use "github".` };
  }

  try {
    const state = await loadState();
    const { token } = await requireGitHub(state);
    const [owner, repo] = splitRepo(repoParam);

    const validStates = ["open", "dismissed", "auto_dismissed", "fixed"] as const;
    type AlertStateParam = (typeof validStates)[number];

    const stateParam: AlertStateParam = alertState !== undefined &&
        (validStates as readonly string[]).includes(alertState)
      ? (alertState as AlertStateParam)
      : "open";

    const alerts: SecurityAlert[] = await ghListSecurityAlerts(token, owner, repo, {
      state: stateParam,
    });

    return ok(alerts, `Security Alerts in ${repoParam} (${alerts.length})`);
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * Handler for the `search` capability.
 *
 * Searches code across repositories.
 *
 * - **GitHub**: Global code search (or scoped to `repo` if provided).
 * - **GitLab**: Project-scoped search. When `repo` is omitted, iterates over
 *   up to {@link GITLAB_SEARCH_MAX_REPOS} monitored projects.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Optional. `"github"` or `"gitlab"`. When
 *   omitted, searches both platforms.
 * @param ctx.params.query - Required. Search query string.
 * @param ctx.params.repo - Optional. `"owner/repo"` to scope the search.
 * @returns Serialised `CodeResult[]` on success, or `{ error }` on failure.
 */
async function handleSearch(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const query = ctx.params["query"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;

  if (query === undefined) return { error: 'Parameter "query" is required.' };

  try {
    const state = await loadState();
    const results: CodeResult[] = [];

    if (platform === undefined || platform === "github") {
      try {
        const { token } = await requireGitHub(state);
        const opts: { repo?: string } = {};
        if (repoParam !== undefined) opts.repo = repoParam;
        results.push(...(await ghSearchCode(token, query, opts)));
      } catch (err) {
        if (platform === "github") throw err;
      }
    }

    if (platform === undefined || platform === "gitlab") {
      try {
        const { token, glState } = await requireGitLab(state);

        if (repoParam !== undefined) {
          // Scoped search: single project.
          const glResults = await glSearchCode(
            token,
            encodeProjectPath(repoParam),
            query,
          );
          results.push(...glResults);
        } else {
          // Unscoped search: iterate monitored projects up to the cap.
          const projectsCapped = glState.monitoredRepos.slice(0, GITLAB_SEARCH_MAX_REPOS);
          const glResults = await fanOut(
            projectsCapped,
            FAN_OUT_CONCURRENCY,
            (fullName) => glSearchCode(token, encodeProjectPath(fullName), query),
          );
          results.push(...glResults);
        }
      } catch (err) {
        if (platform === "gitlab") throw err;
      }
    }

    return ok(results, `Code Search: "${query}" (${results.length} results)`);
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// monitor_add
// ---------------------------------------------------------------------------

/**
 * Handler for the `monitor_add` capability.
 *
 * Adds a repository to the monitored repositories list for the given
 * platform. The repository must be accessible with the currently configured
 * token; this is verified by calling the repo info endpoint before adding.
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @returns Confirmation text on success, or `{ error }` on failure.
 */
async function handleMonitorAdd(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };

  if (platform !== "github" && platform !== "gitlab") {
    return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
  }

  try {
    const state = await loadState();

    // Verify repository accessibility before adding to the monitor list.
    if (platform === "github") {
      const { token } = await requireGitHub(state);
      const [owner, repo] = splitRepo(repoParam);
      await ghGetRepo(token, owner, repo);

      const ghState = state.github!;
      if (!ghState.monitoredRepos.includes(repoParam)) {
        ghState.monitoredRepos.push(repoParam);
        await saveState(state);
      }
    } else {
      const { token } = await requireGitLab(state);
      await glGetProject(token, encodeProjectPath(repoParam));

      const glState = state.gitlab!;
      if (!glState.monitoredRepos.includes(repoParam)) {
        glState.monitoredRepos.push(repoParam);
        await saveState(state);
      }
    }

    return {
      title: "Repository added",
      text: `${repoParam} (${platform}) is now being monitored.`,
    };
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// monitor_remove
// ---------------------------------------------------------------------------

/**
 * Handler for the `monitor_remove` capability.
 *
 * Removes a repository from the monitored repositories list for the given
 * platform. If the repository is not currently monitored, a success message
 * is still returned (idempotent operation).
 *
 * @param ctx - Capability invocation context.
 * @param ctx.params.platform - Required. `"github"` or `"gitlab"`.
 * @param ctx.params.repo - Required. `"owner/repo"` full name.
 * @returns Confirmation text on success, or `{ error }` on failure.
 */
async function handleMonitorRemove(ctx: CapabilityContext): Promise<CapabilityResult> {
  const platform = ctx.params["platform"] as string | undefined;
  const repoParam = ctx.params["repo"] as string | undefined;

  if (platform === undefined) return { error: 'Parameter "platform" is required.' };
  if (repoParam === undefined) return { error: 'Parameter "repo" is required.' };

  if (platform !== "github" && platform !== "gitlab") {
    return { error: `Unknown platform "${platform}". Use "github" or "gitlab".` };
  }

  try {
    const state = await loadState();

    if (platform === "github") {
      if (state.github === undefined) {
        return { error: "GitHub is not configured." };
      }
      const before = state.github.monitoredRepos.length;
      state.github.monitoredRepos = state.github.monitoredRepos.filter(
        (r) => r !== repoParam,
      );
      if (state.github.monitoredRepos.length !== before) {
        await saveState(state);
      }
    } else {
      if (state.gitlab === undefined) {
        return { error: "GitLab is not configured." };
      }
      const before = state.gitlab.monitoredRepos.length;
      state.gitlab.monitoredRepos = state.gitlab.monitoredRepos.filter(
        (r) => r !== repoParam,
      );
      if (state.gitlab.monitoredRepos.length !== before) {
        await saveState(state);
      }
    }

    return {
      title: "Repository removed",
      text: `${repoParam} (${platform}) is no longer being monitored.`,
    };
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// monitor_status
// ---------------------------------------------------------------------------

/**
 * Represents a summary of the monitor status for a single platform.
 *
 * Returned as part of the `monitor_status` capability result.
 */
interface PlatformStatusSummary {
  /** Whether the platform account is connected. */
  connected: boolean;
  /** Authenticated username, if connected. */
  username?: string;
  /** Number of currently monitored repositories. */
  monitoredRepoCount: number;
  /** Full names of monitored repositories. */
  monitoredRepos: string[];
  /** ISO 8601 timestamp of last successful poll, or `null`. */
  lastPollAt: string | null;
}

/**
 * Shape of the `monitor_status` capability result body.
 */
interface MonitorStatusResult {
  /** GitHub account status. */
  github: PlatformStatusSummary;
  /** GitLab account status. */
  gitlab: PlatformStatusSummary;
  /** Current notification and polling settings. */
  settings: {
    pollIntervalMinutes: number;
    notifyOnReviewRequest: boolean;
    notifyOnCIFailure: boolean;
    notifyOnSecurityAlert: boolean;
    notifyOnMention: boolean;
    ciFailureBranches: string[];
  };
}

/**
 * Handler for the `monitor_status` capability.
 *
 * Returns a summary of the current monitor configuration: which platforms
 * are connected, which repositories are being monitored, when each platform
 * was last polled, and the active notification settings.
 *
 * @param _ctx - Capability invocation context (no parameters used).
 * @returns Serialised {@link MonitorStatusResult} on success, or `{ error }`
 *   on failure.
 */
async function handleMonitorStatus(_ctx: CapabilityContext): Promise<CapabilityResult> {
  try {
    const state = await loadState();

    // Build each platform summary conditionally so optional `username` is
    // never assigned `undefined` (required by exactOptionalPropertyTypes).
    const github: PlatformStatusSummary = state.github !== undefined
      ? {
        connected: true,
        username: state.github.username,
        monitoredRepoCount: state.github.monitoredRepos.length,
        monitoredRepos: [...state.github.monitoredRepos],
        lastPollAt: state.github.lastPollAt,
      }
      : {
        connected: false,
        monitoredRepoCount: 0,
        monitoredRepos: [],
        lastPollAt: null,
      };

    const gitlab: PlatformStatusSummary = state.gitlab !== undefined
      ? {
        connected: true,
        username: state.gitlab.username,
        monitoredRepoCount: state.gitlab.monitoredRepos.length,
        monitoredRepos: [...state.gitlab.monitoredRepos],
        lastPollAt: state.gitlab.lastPollAt,
      }
      : {
        connected: false,
        monitoredRepoCount: 0,
        monitoredRepos: [],
        lastPollAt: null,
      };

    const result: MonitorStatusResult = {
      github,
      gitlab,
      settings: { ...state.settings },
    };

    return ok(result, "Monitor Status");
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Registers all 18 Chalie Git Interface capabilities with the SDK shim
 * dispatcher.
 *
 * Must be called once during tool startup, before the event loop starts.
 * Registering the same capability name twice overwrites the previous entry.
 *
 * @example
 * ```ts
 * import { registerAllCapabilities } from "~/capabilities/index.ts";
 * registerAllCapabilities();
 * // then: runEventLoop();
 * ```
 */
export function registerAllCapabilities(): void {
  // ---- repo_list -----------------------------------------------------------
  registerCapability(
    "repo_list",
    {
      description: "List all repositories accessible to the configured account(s).",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description:
              "Optional platform filter. When omitted, returns repos from both platforms.",
          },
        },
      },
    },
    handleRepoList,
  );

  // ---- repo_info -----------------------------------------------------------
  registerCapability(
    "repo_info",
    {
      description: "Get detailed metadata for a single repository.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
        },
        required: ["platform", "repo"],
      },
    },
    handleRepoInfo,
  );

  // ---- pr_list -------------------------------------------------------------
  registerCapability(
    "pr_list",
    {
      description:
        "List pull/merge requests. Fans out across all monitored repos when no `repo` is given.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Platform filter. Required when `repo` is specified; " +
              "when omitted, both platforms are queried.",
          },
          repo: {
            type: "string",
            description: 'Optional "owner/repo". When absent, fans out across all monitored repos.',
          },
          filter: {
            type: "string",
            enum: ["open", "closed", "merged", "mine", "review_requested", "draft"],
            description: '"open" (default) | "closed" | "merged" | "mine" (authored by me) | ' +
              '"review_requested" (I am a requested reviewer) | "draft" (open drafts).',
          },
        },
      },
    },
    handlePrList,
  );

  // ---- pr_get --------------------------------------------------------------
  registerCapability(
    "pr_get",
    {
      description: "Get detailed information for a single pull/merge request.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
          number: {
            type: "integer",
            description: "Pull/merge request number.",
          },
        },
        required: ["platform", "repo", "number"],
      },
    },
    handlePrGet,
  );

  // ---- pr_create -----------------------------------------------------------
  registerCapability(
    "pr_create",
    {
      description: "Create a new pull request (GitHub) or merge request (GitLab).",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
          title: { type: "string", description: "PR/MR title." },
          head: { type: "string", description: "Source branch name." },
          base: { type: "string", description: "Target branch name." },
          body: { type: "string", description: "Optional PR/MR description." },
          draft: {
            type: "boolean",
            description: "Whether to create as a draft PR/MR.",
          },
        },
        required: ["platform", "repo", "title", "head", "base"],
      },
    },
    handlePrCreate,
  );

  // ---- pr_merge ------------------------------------------------------------
  registerCapability(
    "pr_merge",
    {
      description: "Merge an open pull/merge request.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
          number: { type: "integer", description: "PR/MR number." },
          method: {
            type: "string",
            enum: ["merge", "squash", "rebase"],
            description: 'Merge method. Defaults to "merge". ' +
              'GitLab supports "merge" and "squash" only; "rebase" is treated as "merge".',
          },
        },
        required: ["platform", "repo", "number"],
      },
    },
    handlePrMerge,
  );

  // ---- pr_review -----------------------------------------------------------
  registerCapability(
    "pr_review",
    {
      description: "Submit a code review on a pull/merge request. " +
        'GitHub supports all events; GitLab supports "comment" only.',
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
          number: { type: "integer", description: "PR/MR number." },
          event: {
            type: "string",
            enum: ["approve", "request_changes", "comment"],
            description: '"approve" | "request_changes" | "comment". ' +
              'GitLab supports "comment" only.',
          },
          body: {
            type: "string",
            description: "Review body text. Required for GitLab comments.",
          },
        },
        required: ["platform", "repo", "number", "event"],
      },
    },
    handlePrReview,
  );

  // ---- issue_list ----------------------------------------------------------
  registerCapability(
    "issue_list",
    {
      description: "List repository issues with optional state and ownership filters.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
          filter: {
            type: "string",
            enum: ["open", "closed", "mine", "assigned", "all"],
            description: '"open" (default) | "closed" | "mine" (authored by me) | ' +
              '"assigned" (assigned to me) | "all".',
          },
        },
        required: ["platform", "repo"],
      },
    },
    handleIssueList,
  );

  // ---- issue_create --------------------------------------------------------
  registerCapability(
    "issue_create",
    {
      description: "Create a new issue in a repository.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
          title: { type: "string", description: "Issue title." },
          body: { type: "string", description: "Optional issue description." },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Optional array of label names to apply.",
          },
          assignees: {
            type: "array",
            items: { type: "string" },
            description: "Optional array of usernames to assign (GitHub only).",
          },
        },
        required: ["platform", "repo", "title"],
      },
    },
    handleIssueCreate,
  );

  // ---- issue_update --------------------------------------------------------
  registerCapability(
    "issue_update",
    {
      description: "Update an existing issue. Only provided fields are modified. " +
        "Assignees are GitHub-only (GitLab uses numeric user IDs).",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
          number: { type: "integer", description: "Issue number." },
          title: { type: "string", description: "New title." },
          body: { type: "string", description: "New description." },
          state: {
            type: "string",
            enum: ["open", "closed"],
            description: "New state.",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Replacement label list.",
          },
          assignees: {
            type: "array",
            items: { type: "string" },
            description: "Replacement assignee list (usernames; GitHub only).",
          },
        },
        required: ["platform", "repo", "number"],
      },
    },
    handleIssueUpdate,
  );

  // ---- branch_list ---------------------------------------------------------
  registerCapability(
    "branch_list",
    {
      description: "List all branches in a repository.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
        },
        required: ["platform", "repo"],
      },
    },
    handleBranchList,
  );

  // ---- pipeline_list -------------------------------------------------------
  registerCapability(
    "pipeline_list",
    {
      description: "List recent CI/CD pipeline or GitHub Actions workflow runs.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
          branch: {
            type: "string",
            description: "Optional branch name to filter by.",
          },
          status: {
            type: "string",
            description: 'Optional status to filter by (e.g. "failed", "success").',
          },
        },
        required: ["platform", "repo"],
      },
    },
    handlePipelineList,
  );

  // ---- pipeline_trigger ----------------------------------------------------
  registerCapability(
    "pipeline_trigger",
    {
      description: "Trigger a new CI/CD pipeline run. " +
        'GitHub requires `workflow_id` (the workflow filename, e.g. "ci.yml"). ' +
        "GitLab uses `triggerPipeline` on the specified ref.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
          ref: {
            type: "string",
            description: "Branch or tag ref to run the pipeline against.",
          },
          workflow_id: {
            type: "string",
            description:
              'Workflow filename (e.g. "ci.yml"). Required for GitHub; ignored for GitLab.',
          },
          inputs: {
            type: "object",
            description:
              "Optional key/value map of workflow inputs (GitHub) or CI variables (GitLab).",
          },
        },
        required: ["platform", "repo", "ref"],
      },
    },
    handlePipelineTrigger,
  );

  // ---- security_alerts -----------------------------------------------------
  registerCapability(
    "security_alerts",
    {
      description: "List Dependabot security alerts for a repository. GitHub only.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github"],
            description: 'Must be "github". Security alerts are GitHub-only.',
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
          state: {
            type: "string",
            enum: ["open", "dismissed", "auto_dismissed", "fixed"],
            description: 'Alert state filter. Defaults to "open".',
          },
        },
        required: ["platform", "repo"],
      },
    },
    handleSecurityAlerts,
  );

  // ---- search --------------------------------------------------------------
  registerCapability(
    "search",
    {
      description: "Search code across repositories. GitHub: global search. " +
        "GitLab: project-scoped (up to 10 monitored projects when `repo` is omitted).",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Optional platform filter. When omitted, searches both.",
          },
          query: {
            type: "string",
            description: "Search query string.",
          },
          repo: {
            type: "string",
            description: 'Optional "owner/repo" to scope the search.',
          },
        },
        required: ["query"],
      },
    },
    handleSearch,
  );

  // ---- monitor_add ---------------------------------------------------------
  registerCapability(
    "monitor_add",
    {
      description: "Add a repository to the background monitor. " +
        "Verifies accessibility before adding.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
        },
        required: ["platform", "repo"],
      },
    },
    handleMonitorAdd,
  );

  // ---- monitor_remove ------------------------------------------------------
  registerCapability(
    "monitor_remove",
    {
      description: "Remove a repository from the background monitor (idempotent).",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["github", "gitlab"],
            description: "Hosting platform.",
          },
          repo: {
            type: "string",
            description: 'Repository full name in "owner/repo" format.',
          },
        },
        required: ["platform", "repo"],
      },
    },
    handleMonitorRemove,
  );

  // ---- monitor_status ------------------------------------------------------
  registerCapability(
    "monitor_status",
    {
      description: "Return a summary of the monitor configuration: connected platforms, " +
        "monitored repos, last poll times, and notification settings.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    handleMonitorStatus,
  );
}
