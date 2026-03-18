/**
 * @module sdk-shim/types
 *
 * Shared type definitions for the Chalie Interface SDK shim.
 * These mirror the expected public API of `@chalie/interface-sdk@1`.
 */

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * Declares the signal and message topics a tool emits at registration
 * time. Chalie uses these at load time to configure routing and UI.
 */
export interface Scopes {
  /** Message topics this tool can emit (e.g. `["review_request"]`). */
  messages?: string[];
  /** Signal types this tool can emit (e.g. `["ci_failure"]`). */
  signals?: string[];
}

// ---------------------------------------------------------------------------
// Signal / Message
// ---------------------------------------------------------------------------

/**
 * Activation energy level for a world-state signal.
 * Higher energy signals are more likely to be surfaced to the user.
 */
export type SignalEnergy = "low" | "medium" | "high" | "critical";

/**
 * A world-state signal emitted by the tool to notify Chalie of an
 * event in the external world. Chalie decides whether to surface it.
 */
export interface Signal {
  /** Discriminated signal type, scoped to the emitting tool. */
  type: string;
  /** Human-readable summary of the signal. */
  text: string;
  /** Activation energy — how urgently Chalie should react. */
  energy: SignalEnergy;
  /** Arbitrary structured metadata attached to the signal. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/**
 * JSON Schema–compatible parameter descriptor for a capability.
 */
export interface CapabilityParamSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/**
 * Full schema descriptor for a registered capability.
 */
export interface CapabilitySchema {
  /** Unique snake_case identifier (e.g. `"pr_list"`). */
  name: string;
  /** Short human-readable description shown in Chalie's UI. */
  description: string;
  /** JSON Schema for the capability's input parameters. */
  parameters: CapabilityParamSchema;
}

/**
 * Invocation context passed to a capability handler.
 */
export interface CapabilityContext {
  /** Raw parameter object as provided by the caller. */
  params: Record<string, unknown>;
  /** ISO 8601 timestamp of the invocation. */
  invokedAt: string;
}

/**
 * Result returned by a capability handler.
 * One of `text` or `html` must be present.
 */
export interface CapabilityResult {
  /** Plain-text result for capabilities that return prose. */
  text?: string;
  /** HTML result for capabilities that return structured UI. */
  html?: string;
  /** Optional title for the capability result panel. */
  title?: string;
  /** Error message if the capability failed. */
  error?: string;
}

/** A synchronous or asynchronous capability handler function. */
export type CapabilityHandler = (
  ctx: CapabilityContext,
) => CapabilityResult | Promise<CapabilityResult>;

// ---------------------------------------------------------------------------
// IPC wire types
// ---------------------------------------------------------------------------

/**
 * Inbound IPC message received from Chalie via stdin (base64-encoded JSON).
 */
export interface InboundMessage {
  /** Capability name being invoked, if this is a capability call. */
  capability?: string;
  /** Parameters for the capability invocation. */
  params?: Record<string, unknown>;
  /** Raw text payload for non-capability messages. */
  text?: string;
}

/**
 * Outbound IPC response sent to Chalie via stdout (base64-encoded JSON).
 */
export interface OutboundResponse {
  text?: string;
  html?: string;
  title?: string;
  error?: string;
}
