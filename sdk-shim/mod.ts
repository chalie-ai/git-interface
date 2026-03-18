/**
 * @module sdk-shim
 *
 * Compatibility shim for `@chalie/interface-sdk`.
 *
 * The Chalie Interface SDK (`jsr:@chalie/interface-sdk@1`) is not yet
 * published. This module provides the same public API that the rest of
 * the tool depends on, bridging to Chalie's existing base64-encoded
 * JSON IPC protocol (stdin/stdout line-delimited messages).
 *
 * Once the official SDK is available this file can be replaced with a
 * thin re-export and the import map entry updated.
 *
 * ## IPC Protocol (current Chalie convention)
 * Each turn:
 * - Tool reads one base64-encoded JSON object from stdin.
 * - Tool writes one base64-encoded JSON response object to stdout.
 * Response shape: `{ text?: string; html?: string; title?: string; error?: string }`.
 *
 * @example
 * ```ts
 * import { sendMessage, sendSignal, dataDir } from "@chalie/interface-sdk";
 * ```
 */
export * from "./ipc.ts";
export * from "./secrets.ts";
export * from "./registry.ts";
export * from "./types.ts";
