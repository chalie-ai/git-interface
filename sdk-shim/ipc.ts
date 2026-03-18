/**
 * @module sdk-shim/ipc
 *
 * Low-level IPC helpers that implement Chalie's base64-encoded JSON
 * stdin/stdout protocol. Higher-level APIs (`sendMessage`, `sendSignal`)
 * are built on top of these primitives.
 */

import type { InboundMessage, OutboundResponse, Signal, SignalEnergy } from "./types.ts";

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

/**
 * Returns the writable data directory for persistent tool state.
 *
 * Resolution order:
 * 1. `CHALIE_DATA_DIR` environment variable (set by the Chalie runtime).
 * 2. `XDG_DATA_HOME/chalie/git-interface` on Linux/macOS.
 * 3. `%APPDATA%/chalie/git-interface` on Windows.
 * 4. `~/.local/share/chalie/git-interface` fallback.
 */
export function dataDir(): string {
  const envDir = Deno.env.get("CHALIE_DATA_DIR");
  if (envDir) return envDir;

  const xdg = Deno.env.get("XDG_DATA_HOME");
  if (xdg) return `${xdg}/chalie/git-interface`;

  const appData = Deno.env.get("APPDATA");
  if (appData) return `${appData}/chalie/git-interface`;

  const home = Deno.env.get("HOME") ?? ".";
  return `${home}/.local/share/chalie/git-interface`;
}

// ---------------------------------------------------------------------------
// Wire encoding
// ---------------------------------------------------------------------------

/**
 * Encodes an outbound response object to a base64 JSON string ready for
 * writing to stdout.
 *
 * @param response - The structured response to encode.
 * @returns A base64-encoded UTF-8 JSON string followed by a newline.
 */
export function encodeResponse(response: OutboundResponse): string {
  const json = JSON.stringify(response);
  const bytes = new TextEncoder().encode(json);
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64 + "\n";
}

/**
 * Decodes a single base64-encoded JSON line received from stdin into a
 * typed inbound message.
 *
 * @param line - A single newline-terminated base64 string.
 * @returns The decoded inbound message.
 * @throws {SyntaxError} If the decoded bytes are not valid JSON.
 */
export function decodeMessage(line: string): InboundMessage {
  const trimmed = line.trim();
  const binary = atob(trimmed);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as InboundMessage;
}

// ---------------------------------------------------------------------------
// High-level send helpers
// ---------------------------------------------------------------------------

/**
 * Reads and decodes one base64-encoded JSON line from stdin.
 *
 * Accumulates bytes from stdin until a newline character is found, then
 * decodes the complete line as a base64 JSON object. This function blocks
 * until a full line is available.
 *
 * @returns A promise that resolves to the decoded {@link InboundMessage}.
 * @throws {Error} If stdin reaches EOF before a complete line is received.
 * @throws {SyntaxError} If the decoded bytes are not valid JSON.
 *
 * @example
 * ```ts
 * const msg = await readRequest();
 * console.log(msg.capability); // e.g. "pr_list"
 * ```
 */
export async function readRequest(): Promise<InboundMessage> {
  const decoder = new TextDecoder();
  const buf = new Uint8Array(4096);
  let pending = "";

  while (true) {
    let bytesRead: number | null;
    try {
      bytesRead = await Deno.stdin.read(buf);
    } catch (err) {
      throw new Error(
        `Failed to read from stdin: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (bytesRead === null) {
      throw new Error("stdin closed (EOF) before a complete message was received.");
    }

    pending += decoder.decode(buf.subarray(0, bytesRead));

    const newlineIdx = pending.indexOf("\n");
    if (newlineIdx !== -1) {
      const line = pending.slice(0, newlineIdx);
      return decodeMessage(line);
    }
  }
}

/**
 * Writes a structured response to stdout using the Chalie IPC protocol.
 *
 * Prefer `sendMessage` or `sendSignal` over calling this directly.
 *
 * @param response - Response object to send.
 */
export function writeResponse(response: OutboundResponse): void {
  const encoded = encodeResponse(response);
  Deno.stdout.writeSync(new TextEncoder().encode(encoded));
}

/**
 * Injects a high-priority message into Chalie's reasoning loop.
 * Messages always surface to the user immediately.
 *
 * @param text - Human-readable message text.
 * @param topic - Optional topic tag for routing (e.g. `"review_request"`).
 */
export function sendMessage(text: string, topic?: string): void {
  writeResponse({
    text: topic ? `[${topic}] ${text}` : text,
    title: topic,
  });
}

/**
 * Emits a world-state signal at the specified activation energy.
 * Chalie decides whether to surface the signal based on context and energy.
 *
 * @param type - Discriminated signal type string.
 * @param text - Human-readable signal summary.
 * @param energy - Activation energy level.
 * @param metadata - Optional structured metadata attached to the signal.
 */
export function sendSignal(
  type: string,
  text: string,
  energy: SignalEnergy,
  metadata?: Record<string, unknown>,
): void {
  const signal: Signal = { type, text, energy, ...(metadata ? { metadata } : {}) };
  writeResponse({
    text,
    title: `signal:${type}:${energy}`,
    html: `<signal>${JSON.stringify(signal)}</signal>`,
  });
}

/**
 * Writes an error response to stdout.
 *
 * @param message - User-friendly error message.
 */
export function sendError(message: string): void {
  writeResponse({ error: message });
}
