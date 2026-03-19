/**
 * @module sdk-shim/registry
 *
 * Capability registration and dispatch for the Chalie Interface SDK shim.
 *
 * Tools declare their capabilities at startup by calling
 * `registerCapability`. The IPC event loop (started by `runEventLoop`)
 * reads inbound messages from stdin and dispatches each capability call
 * to the registered handler, then writes the result back to stdout.
 */

import type {
  CapabilityContext,
  CapabilityHandler,
  CapabilityResult,
  CapabilitySchema,
  InboundMessage,
  Scopes,
} from "./types.ts";
import { decodeMessage, sendError, writeResponse } from "./ipc.ts";

// ---------------------------------------------------------------------------
// Internal registry
// ---------------------------------------------------------------------------

interface CapabilityEntry {
  schema: CapabilitySchema;
  handler: CapabilityHandler;
}

const _registry = new Map<string, CapabilityEntry>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Registers a capability with Chalie's dispatcher.
 *
 * Must be called before `runEventLoop`. Calling this function with a
 * name that is already registered will overwrite the previous entry.
 *
 * @param schema - Capability metadata and JSON Schema for parameters.
 * @param handler - Async function invoked when the capability is called.
 */
export function registerCapability(schema: CapabilitySchema, handler: CapabilityHandler): void {
  _registry.set(schema.name, { schema, handler });
}

/**
 * Returns the schemas of all currently registered capabilities.
 * Used at startup to advertise available capabilities to the Chalie runtime.
 *
 * @returns Array of capability schemas in registration order.
 */
export function listRegisteredCapabilities(): CapabilitySchema[] {
  return Array.from(_registry.values()).map((e) => e.schema);
}

/**
 * Dispatches a decoded inbound message to the appropriate capability
 * handler and returns its result.
 *
 * @param message - Decoded inbound IPC message.
 * @returns The capability result, or an error result if dispatch fails.
 */
export async function dispatch(message: InboundMessage): Promise<CapabilityResult> {
  const name = message.capability;
  if (!name) {
    return { error: "Inbound message has no `capability` field." };
  }

  const entry = _registry.get(name);
  if (!entry) {
    return { error: `Unknown capability: "${name}". Available: ${[..._registry.keys()].join(", ")}` };
  }

  const ctx: CapabilityContext = {
    params: message.params ?? {},
    invokedAt: new Date().toISOString(),
  };

  try {
    return await entry.handler(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Capability "${name}" threw an unexpected error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Event loop
// ---------------------------------------------------------------------------

/**
 * Starts the main IPC event loop, reading base64-encoded JSON messages
 * from stdin and writing responses to stdout.
 *
 * The loop runs until stdin is closed (EOF). Each iteration:
 * 1. Reads one newline-terminated base64 line from stdin.
 * 2. Decodes and dispatches to the registered capability handler.
 * 3. Encodes and writes the result to stdout.
 *
 * @param scopes - Optional scopes declaration advertised to the runtime.
 *   Not used by the current shim but accepted for API parity with the
 *   future `@chalie/interface-sdk@1`.
 *
 * @deprecated **Do not call this function.** `main.ts` implements its own
 *   custom IPC event loop using `readRequest`/`writeResponse` directly,
 *   which provides finer-grained control over startup sequencing and
 *   shutdown. This function body is retained solely to preserve API parity
 *   with the future `jsr:@chalie/interface-sdk@1` and is **not exported**
 *   from `sdk-shim/mod.ts`. When the real SDK ships, both this function
 *   and the custom loop in `main.ts` will be replaced by the SDK's
 *   equivalent entrypoint.
 */
export async function runEventLoop(_scopes?: Scopes): Promise<void> {
  const decoder = new TextDecoder();
  const buf = new Uint8Array(4096);

  let pending = "";

  while (true) {
    let bytesRead: number | null;
    try {
      bytesRead = await Deno.stdin.read(buf);
    } catch {
      break;
    }
    if (bytesRead === null) break;

    pending += decoder.decode(buf.subarray(0, bytesRead));

    let newlineIdx: number;
    while ((newlineIdx = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newlineIdx);
      pending = pending.slice(newlineIdx + 1);

      if (!line.trim()) continue;

      let message: InboundMessage;
      try {
        message = decodeMessage(line);
      } catch (err) {
        sendError(`Failed to decode inbound message: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const result = await dispatch(message);
      writeResponse(result);
    }
  }
}
