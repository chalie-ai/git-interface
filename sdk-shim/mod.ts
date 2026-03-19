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
 * ## Module structure
 *
 * | Module | Role |
 * |--------|------|
 * | `types.ts` | Shared wire-protocol and capability type definitions. |
 * | `ipc.ts` | Low-level base64-JSON encode/decode and stdin/stdout helpers. |
 * | `index.ts` | High-level façade: `registerCapability`, `dispatch`, `secrets`. |
 * | `registry.ts` | Internal capability map; `runEventLoop` is kept for future SDK parity but is NOT part of the public API (unexported from this module). |
 * | `secrets.ts` | Secure token storage (Chalie socket → encrypted file). |
 *
 * @example
 * ```ts
 * import { sendMessage, sendSignal, dataDir } from "@chalie/interface-sdk";
 * ```
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------
export * from "./types.ts";

// ---------------------------------------------------------------------------
// Low-level IPC helpers
// (`readRequest`, `writeResponse`, `encodeResponse`, `decodeMessage`,
//  `sendError` — note: `sendMessage`, `sendSignal`, and `dataDir` are
//  exported via `index.ts` below to keep a single canonical source)
// ---------------------------------------------------------------------------
export { decodeMessage, encodeResponse, readRequest, sendError, writeResponse } from "./ipc.ts";

// ---------------------------------------------------------------------------
// High-level API façade
// (`sendMessage`, `sendSignal`, `dataDir`, `registerCapability`,
//  `dispatch`, `secrets`)
// ---------------------------------------------------------------------------
export * from "./index.ts";

// ---------------------------------------------------------------------------
// Registry internals
// (capability introspection not covered by the façade)
// Note: `runEventLoop` is intentionally NOT re-exported here. `main.ts`
// implements its own custom IPC loop using `readRequest`/`writeResponse`
// directly for finer startup/shutdown control. `runEventLoop` remains in
// `registry.ts` only for API-parity with the future real SDK.
// ---------------------------------------------------------------------------
export { listRegisteredCapabilities } from "./registry.ts";

// ---------------------------------------------------------------------------
// Secrets internals
// (lower-level ref-based API for advanced consumers)
// ---------------------------------------------------------------------------
export { deleteSecret, retrieveSecret, storeSecret } from "./secrets.ts";
export type { SecretRef } from "./secrets.ts";
