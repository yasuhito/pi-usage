import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piUsage from "../index.ts";

test("package entry point registers the Codex quota lifecycle", () => {
  const events: string[] = [];
  const pi = {
    on: (event: string) => {
      events.push(event);
    },
  } as unknown as ExtensionAPI;

  piUsage(pi);

  assert.deepEqual(events.sort(), [
    "after_provider_response",
    "agent_settled",
    "model_select",
    "session_shutdown",
    "session_start",
  ]);
});
