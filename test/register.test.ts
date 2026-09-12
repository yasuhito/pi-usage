import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import type { CodexCredential } from "../src/dedicated-weekly-quota-acquisition.ts";
import { registerWeeklyQuotaUsage } from "../src/register.ts";

function accessTokenFor(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

type ExtensionHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => void | Promise<void>;

function registerFixture() {
  const handlers = new Map<string, ExtensionHandler[]>();
  const pi = {
    on(event: string, handler: ExtensionHandler): void {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  } as unknown as ExtensionAPI;
  const observedCredentials: CodexCredential[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  let mode: ExtensionContext["mode"] = "tui";
  let provider = "openai-codex";
  let authEnabled = true;
  let pollingStarted = 0;
  let pollingStopped = 0;

  registerWeeklyQuotaUsage(pi, {
    now: () => 1_000_000,
    random: () => 0.5,
    schedule: () => () => {},
    acquireDedicatedWeeklyQuotaUsage: async (credential) => {
      observedCredentials.push(credential);
      return {
        kind: "acquired",
        usage: {
          usedPercent: 63.4,
          resetsAtMs: 2_000_000,
          windowPosition: "secondary",
          availableLimitResetCredits: 2,
        },
      };
    },
    startPolling: () => {
      pollingStarted += 1;
      return () => {
        pollingStopped += 1;
      };
    },
  });

  const ctx = {
    get mode() {
      return mode;
    },
    get model() {
      return { provider };
    },
    modelRegistry: {
      getProviderAuth: async () =>
        authEnabled
          ? {
              auth: { apiKey: accessTokenFor("account-1") },
              source: "OAuth" as const,
            }
          : undefined,
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (key: string, text: string | undefined) =>
        statuses.push({ key, text }),
    },
  } as unknown as ExtensionContext;

  const emit = async (event: string, payload: unknown = {}): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  };

  return {
    emit,
    observedCredentials,
    pollingStarted: () => pollingStarted,
    pollingStopped: () => pollingStopped,
    setAuthEnabled: (value: boolean) => {
      authEnabled = value;
    },
    setMode: (value: ExtensionContext["mode"]) => {
      mode = value;
    },
    setProvider: (value: string) => {
      provider = value;
    },
    statuses,
  };
}

test("session start adapts Pi authentication and quota presentation", async () => {
  const fixture = registerFixture();

  await fixture.emit("session_start");

  assert.deepEqual(fixture.observedCredentials, [
    {
      accessToken: accessTokenFor("account-1"),
      accountId: "account-1",
    },
  ]);
  assert.deepEqual(fixture.statuses, [
    { key: "pi-usage", text: "Codex wk loading…" },
    {
      key: "pi-usage",
      text: "Codex wk ━━━━━━──── 63% · reset 16m · ↻2",
    },
  ]);
});

test("missing Pi authentication clears the status", async () => {
  const fixture = registerFixture();
  fixture.setAuthEnabled(false);

  await fixture.emit("session_start");

  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: undefined,
  });
  assert.equal(fixture.pollingStarted(), 0);
});

test("non-TUI sessions do not start a lifecycle", async () => {
  const fixture = registerFixture();
  fixture.setMode("rpc");

  await fixture.emit("session_start");

  assert.equal(fixture.observedCredentials.length, 0);
  assert.equal(fixture.statuses.length, 0);
});

test("responses from another provider do not enter the lifecycle", async () => {
  const fixture = registerFixture();
  await fixture.emit("session_start");
  fixture.setProvider("anthropic");

  await fixture.emit("after_provider_response", {
    headers: {
      "x-codex-secondary-used-percent": "99",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "4000",
    },
  });

  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk ━━━━━━──── 63% · reset 16m · ↻2",
  });
});

test("a new TUI session replaces and stops the previous lifecycle", async () => {
  const fixture = registerFixture();

  await fixture.emit("session_start");
  await fixture.emit("session_start");
  await fixture.emit("session_shutdown");

  assert.deepEqual(
    { started: fixture.pollingStarted(), stopped: fixture.pollingStopped() },
    { started: 2, stopped: 2 },
  );
});
