/**
 * @module shared
 *
 * Barrel re-export for shared types and utilities used across the
 * Chalie Git Interface tool. Import from this module rather than
 * from individual files to keep cross-package imports stable.
 *
 * @example
 * ```ts
 * import type { Repo, PullRequest, ApiError } from "~/shared/mod.ts";
 * ```
 */
export * from "./types.ts";
