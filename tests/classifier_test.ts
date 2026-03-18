/**
 * @module tests/classifier_test
 *
 * Unit tests for {@link classifyAndNotify} in `monitor/classifier.ts`.
 *
 * ## Testing strategy
 *
 * `sendMessage` and `sendSignal` ultimately call `Deno.stdout.writeSync`
 * with a base64-encoded JSON payload (Chalie's IPC protocol). Rather than
 * modifying production code to inject dependencies, these tests use
 * `stub` from `@std/testing/mock` to replace `Deno.stdout.writeSync` for
 * the duration of each test. The captured bytes are base64-decoded into
 * {@link OutboundResponse} objects for assertion.
 *
 * Distinguishing send primitives by the `title` field:
 * - `sendMessage(text, topic)` → `title: "<topic>"` (e.g. `"review_request"`)
 * - `sendSignal(type, text, energy)` → `title: "signal:<type>:<energy>"`
 *   (e.g. `"signal:ci_failure:high"`)
 *
 * ## Coverage
 *
 * | # | Event type          | Expected output            |
 * |---|---------------------|----------------------------|
 * | 1 | `review_requested`  | `sendMessage` (GitHub)     |
 * | 2 | `ci_failure` main   | `sendSignal` high (GitHub) |
 * | 3 | `ci_failure` feat   | no send (branch filtered)  |
 * | 4 | `security_alert`    | `sendMessage` (GitHub)     |
 * | 5 | `mention`           | `sendSignal` medium (GH)   |
 * | 6 | `pr_merged`         | `sendSignal` low (GitHub)  |
 * | 7 | `issue_assigned`    | `sendSignal` medium (GH)   |
 * | 8 | `ci_failure` + flag | no send (flag=false)       |
 * | 9 | `ci_failure` main   | `sendSignal` high (GitLab) |
 * |10 | `review_requested`  | no send (flag=false)       |
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { stub } from "@std/testing/mock";

import { classifyAndNotify } from "../monitor/classifier.ts";
import type {
  CIFailureEvent,
  IssueAssignedEvent,
  MentionEvent,
  PRMergedEvent,
  ReviewRequestEvent,
  SecurityAlertEvent,
} from "../monitor/classifier.ts";
import type { MonitorSettings, MonitorState } from "../monitor/store.ts";
import type { OutboundResponse } from "../sdk-shim/types.ts";

import {
  GH_ISSUE,
  GH_PIPELINE_FAIL_FEATURE,
  GH_PIPELINE_FAIL_MAIN,
  GH_PR,
  GH_PR_MERGED,
  GH_SECURITY_ALERT,
} from "./fixtures/github_events.ts";
import { GL_ISSUE, GL_PIPELINE_FAIL_MAIN, GL_PR } from "./fixtures/gitlab_events.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Constructs a {@link MonitorState} with all notification flags enabled and
 * `ciFailureBranches` set to `["main", "master"]`. Individual fields may be
 * overridden via `settingsOverrides` to test suppression logic.
 *
 * @param settingsOverrides - Optional partial settings merged over the defaults.
 * @returns A MonitorState ready for use as the second argument to `classifyAndNotify`.
 */
function makeDefaultState(settingsOverrides?: Partial<MonitorSettings>): MonitorState {
  return {
    settings: {
      pollIntervalMinutes: 5,
      notifyOnReviewRequest: true,
      notifyOnCIFailure: true,
      notifyOnSecurityAlert: true,
      notifyOnMention: true,
      ciFailureBranches: ["main", "master"],
      ...settingsOverrides,
    },
  };
}

/**
 * Decodes a single raw write captured from `Deno.stdout.writeSync` into a
 * typed {@link OutboundResponse}.
 *
 * The IPC wire format is: `base64(UTF-8 JSON) + "\n"`. This function
 * trims the trailing newline, base64-decodes the payload, and JSON-parses
 * the result.
 *
 * @param raw - The raw string written to stdout (base64 + trailing newline).
 * @returns The decoded response object.
 * @throws {SyntaxError} If the decoded bytes are not valid JSON.
 */
function decodeWrite(raw: string): OutboundResponse {
  const b64 = raw.trim();
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as OutboundResponse;
}

/**
 * Stubs `Deno.stdout.writeSync` for the duration of `fn`, captures every
 * byte written, then restores the original implementation (even if `fn`
 * throws). Returns the decoded IPC responses emitted by `fn`.
 *
 * Each call to `sendMessage` or `sendSignal` produces exactly one write to
 * `Deno.stdout`, so `responses.length` equals the number of IPC sends.
 *
 * @param fn - Async function whose IPC writes should be intercepted.
 * @returns Decoded {@link OutboundResponse} objects, one per IPC send.
 */
async function captureIPCWrites(fn: () => Promise<void>): Promise<OutboundResponse[]> {
  const rawWrites: string[] = [];

  const ws = stub(
    Deno.stdout,
    "writeSync",
    (data: Uint8Array): number => {
      rawWrites.push(new TextDecoder().decode(data));
      return data.length;
    },
  );

  try {
    await fn();
  } finally {
    ws.restore();
  }

  return rawWrites.map(decodeWrite);
}

// ---------------------------------------------------------------------------
// Tests — Row 1: review_requested → sendMessage
// ---------------------------------------------------------------------------

Deno.test(
  "review_requested: fires sendMessage with review_request topic (GitHub)",
  async () => {
    const event: ReviewRequestEvent = {
      type: "review_requested",
      pr: GH_PR,
      requester: "alice",
    };

    const responses = await captureIPCWrites(() =>
      classifyAndNotify({ events: [event] }, makeDefaultState())
    );

    assertEquals(responses.length, 1, "expected exactly one IPC send");

    const r = responses[0];
    assertExists(r, "response must not be undefined");

    // sendMessage → title equals the bare topic (no "signal:" prefix)
    assertEquals(r.title, "review_request");

    // sendMessage prepends "[<topic>] " to the text
    assertStringIncludes(r.text ?? "", "[review_request]");

    // Key PR context must appear in the message body
    assertStringIncludes(r.text ?? "", "Add OAuth login"); // PR title
    assertStringIncludes(r.text ?? "", "alice"); // requester
    assertStringIncludes(r.text ?? "", "acme/frontend"); // repo
    assertStringIncludes(r.text ?? "", "GitHub"); // platform label
  },
);

// ---------------------------------------------------------------------------
// Tests — Row 2: ci_failure on monitored branch → sendSignal high
// ---------------------------------------------------------------------------

Deno.test(
  "ci_failure on main: fires sendSignal with high energy (GitHub)",
  async () => {
    const event: CIFailureEvent = {
      type: "ci_failure",
      pipeline: GH_PIPELINE_FAIL_MAIN,
    };

    const responses = await captureIPCWrites(() =>
      classifyAndNotify({ events: [event] }, makeDefaultState())
    );

    assertEquals(responses.length, 1, "expected exactly one IPC send");

    const r = responses[0];
    assertExists(r, "response must not be undefined");

    // sendSignal → title follows "signal:<type>:<energy>" pattern
    assertEquals(r.title, "signal:ci_failure:high");

    // Signal text should surface branch, repo, and platform
    assertStringIncludes(r.text ?? "", "main");
    assertStringIncludes(r.text ?? "", "acme/frontend");
    assertStringIncludes(r.text ?? "", "GitHub");

    // Signal metadata is embedded in the html field as a <signal> element
    assertStringIncludes(r.html ?? "", "ci_failure");
  },
);

// ---------------------------------------------------------------------------
// Tests — Row 2 (branch guard): ci_failure on non-monitored branch → no send
// ---------------------------------------------------------------------------

Deno.test(
  "ci_failure on feature branch: no IPC send (branch not in ciFailureBranches)",
  async () => {
    const event: CIFailureEvent = {
      type: "ci_failure",
      pipeline: GH_PIPELINE_FAIL_FEATURE, // branch: "feature/oauth"
    };

    const responses = await captureIPCWrites(() =>
      classifyAndNotify({ events: [event] }, makeDefaultState())
    );

    assertEquals(
      responses.length,
      0,
      "no IPC send expected for a branch not in ciFailureBranches",
    );
  },
);

// ---------------------------------------------------------------------------
// Tests — Row 3: security_alert → sendMessage
// ---------------------------------------------------------------------------

Deno.test(
  "security_alert: fires sendMessage with security_alert topic (GitHub)",
  async () => {
    const event: SecurityAlertEvent = {
      type: "security_alert",
      alert: GH_SECURITY_ALERT,
    };

    const responses = await captureIPCWrites(() =>
      classifyAndNotify({ events: [event] }, makeDefaultState())
    );

    assertEquals(responses.length, 1, "expected exactly one IPC send");

    const r = responses[0];
    assertExists(r, "response must not be undefined");

    assertEquals(r.title, "security_alert");
    assertStringIncludes(r.text ?? "", "[security_alert]");
    assertStringIncludes(r.text ?? "", "lodash"); // package name
    assertStringIncludes(r.text ?? "", "critical"); // severity
    assertStringIncludes(r.text ?? "", "Fix available: 4.17.21"); // fix info
  },
);

// ---------------------------------------------------------------------------
// Tests — Row 4: mention → sendSignal medium
// ---------------------------------------------------------------------------

Deno.test(
  "mention: fires sendSignal with medium energy (GitHub)",
  async () => {
    const event: MentionEvent = {
      type: "mention",
      platform: "github",
      repo: "acme/frontend",
      itemNumber: 42,
      author: "charlie",
      url: "https://github.com/acme/frontend/pull/42#issuecomment-999",
      excerpt: "Hey @alice, LGTM once you address the nit below.",
    };

    const responses = await captureIPCWrites(() =>
      classifyAndNotify({ events: [event] }, makeDefaultState())
    );

    assertEquals(responses.length, 1, "expected exactly one IPC send");

    const r = responses[0];
    assertExists(r, "response must not be undefined");

    assertEquals(r.title, "signal:mention:medium");
    assertStringIncludes(r.text ?? "", "charlie"); // author
    assertStringIncludes(r.text ?? "", "acme/frontend"); // repo
    assertStringIncludes(r.text ?? "", "#42"); // item number
    assertStringIncludes(r.text ?? "", "GitHub"); // platform label
  },
);

// ---------------------------------------------------------------------------
// Tests — Row 5: pr_merged → sendSignal low
// ---------------------------------------------------------------------------

Deno.test(
  "pr_merged: fires sendSignal with low energy (GitHub)",
  async () => {
    const event: PRMergedEvent = {
      type: "pr_merged",
      pr: GH_PR_MERGED,
    };

    const responses = await captureIPCWrites(() =>
      classifyAndNotify({ events: [event] }, makeDefaultState())
    );

    assertEquals(responses.length, 1, "expected exactly one IPC send");

    const r = responses[0];
    assertExists(r, "response must not be undefined");

    assertEquals(r.title, "signal:pr_merged:low");
    assertStringIncludes(r.text ?? "", "Fix header layout"); // PR title
    assertStringIncludes(r.text ?? "", "carol"); // PR author
    assertStringIncludes(r.text ?? "", "acme/frontend"); // repo
  },
);

// ---------------------------------------------------------------------------
// Tests — Row 6: issue_assigned → sendSignal medium
// ---------------------------------------------------------------------------

Deno.test(
  "issue_assigned: fires sendSignal with medium energy (GitHub)",
  async () => {
    const event: IssueAssignedEvent = {
      type: "issue_assigned",
      issue: GH_ISSUE,
      assignee: "alice",
    };

    const responses = await captureIPCWrites(() =>
      classifyAndNotify({ events: [event] }, makeDefaultState())
    );

    assertEquals(responses.length, 1, "expected exactly one IPC send");

    const r = responses[0];
    assertExists(r, "response must not be undefined");

    assertEquals(r.title, "signal:issue_assigned:medium");
    assertStringIncludes(r.text ?? "", "Button alignment broken on mobile"); // issue title
    assertStringIncludes(r.text ?? "", "alice"); // assignee
    assertStringIncludes(r.text ?? "", "acme/frontend"); // repo
  },
);

// ---------------------------------------------------------------------------
// Tests — Suppression: notifyOnCIFailure=false
// ---------------------------------------------------------------------------

Deno.test(
  "notifyOnCIFailure=false: CI failure on monitored branch is suppressed",
  async () => {
    const event: CIFailureEvent = {
      type: "ci_failure",
      pipeline: GH_PIPELINE_FAIL_MAIN,
    };
    const state = makeDefaultState({ notifyOnCIFailure: false });

    const responses = await captureIPCWrites(() =>
      classifyAndNotify({ events: [event] }, state)
    );

    assertEquals(
      responses.length,
      0,
      "no IPC send expected when notifyOnCIFailure is false",
    );
  },
);

// ---------------------------------------------------------------------------
// Tests — GitLab cross-platform: ci_failure main → sendSignal high
// ---------------------------------------------------------------------------

Deno.test(
  "ci_failure on main: fires sendSignal with high energy (GitLab)",
  async () => {
    const event: CIFailureEvent = {
      type: "ci_failure",
      pipeline: GL_PIPELINE_FAIL_MAIN, // platform: "gitlab", branch: "main"
    };

    const responses = await captureIPCWrites(() =>
      classifyAndNotify({ events: [event] }, makeDefaultState())
    );

    assertEquals(responses.length, 1, "expected exactly one IPC send");

    const r = responses[0];
    assertExists(r, "response must not be undefined");

    assertEquals(r.title, "signal:ci_failure:high");

    // Platform label must say "GitLab" not "GitHub"
    assertStringIncludes(r.text ?? "", "GitLab");
    assertStringIncludes(r.text ?? "", "mygroup/backend");
    assertStringIncludes(r.text ?? "", "main");
  },
);

// ---------------------------------------------------------------------------
// Tests — Suppression: notifyOnReviewRequest=false
// ---------------------------------------------------------------------------

Deno.test(
  "notifyOnReviewRequest=false: review_requested event is suppressed",
  async () => {
    const event: ReviewRequestEvent = {
      type: "review_requested",
      pr: GL_PR,
      requester: "eve",
    };
    const state = makeDefaultState({ notifyOnReviewRequest: false });

    const responses = await captureIPCWrites(() =>
      classifyAndNotify({ events: [event] }, state)
    );

    assertEquals(
      responses.length,
      0,
      "no IPC send expected when notifyOnReviewRequest is false",
    );
  },
);

// ---------------------------------------------------------------------------
// Tests — Mixed batch: multiple events produce independent sends
// ---------------------------------------------------------------------------

Deno.test(
  "mixed batch: each qualifying event in a batch produces exactly one IPC send",
  async () => {
    // Two events that both qualify: review_requested + pr_merged
    const events = [
      { type: "review_requested", pr: GH_PR, requester: "alice" } satisfies ReviewRequestEvent,
      { type: "pr_merged", pr: GH_PR_MERGED } satisfies PRMergedEvent,
      // ci_failure on non-monitored branch — should be filtered out
      { type: "ci_failure", pipeline: GH_PIPELINE_FAIL_FEATURE } satisfies CIFailureEvent,
    ];

    const responses = await captureIPCWrites(() =>
      classifyAndNotify({ events }, makeDefaultState())
    );

    // Only the two qualifying events (review + merged) should produce sends;
    // the feature-branch CI failure is silently dropped.
    assertEquals(responses.length, 2, "expected two IPC sends for two qualifying events");

    // Order matches the input order: review_requested first, pr_merged second
    const r0 = responses[0];
    const r1 = responses[1];
    assertExists(r0, "first response must not be undefined");
    assertExists(r1, "second response must not be undefined");

    assertEquals(r0.title, "review_request");
    assertEquals(r1.title, "signal:pr_merged:low");
  },
);

// ---------------------------------------------------------------------------
// Tests — GitLab issue_assigned cross-platform
// ---------------------------------------------------------------------------

Deno.test(
  "issue_assigned: fires sendSignal with medium energy (GitLab)",
  async () => {
    const event: IssueAssignedEvent = {
      type: "issue_assigned",
      issue: GL_ISSUE,
      assignee: "dave",
    };

    const responses = await captureIPCWrites(() =>
      classifyAndNotify({ events: [event] }, makeDefaultState())
    );

    assertEquals(responses.length, 1, "expected exactly one IPC send");

    const r = responses[0];
    assertExists(r, "response must not be undefined");

    assertEquals(r.title, "signal:issue_assigned:medium");
    assertStringIncludes(r.text ?? "", "API returns 500 on empty request body"); // issue title
    assertStringIncludes(r.text ?? "", "dave"); // assignee
    assertStringIncludes(r.text ?? "", "GitLab"); // platform label
  },
);
