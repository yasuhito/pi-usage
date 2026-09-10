import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  type CodexCredential,
  CodexUsageRequestError,
} from "../src/codex-usage.ts";
import { registerUsage } from "../src/register.ts";

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
  const observedSignals: Array<AbortSignal | undefined> = [];
  let accountId = "account-1";
  let authEnabled = true;
  let authReads = 0;
  let pollingStarted = 0;
  let pollingStopped = 0;
  let readsFail = false;
  let readError: Error | undefined;
  let readGate: Promise<void> | undefined;
  let now = 1_000_000;

  registerUsage(pi, {
    now: () => now,
    random: () => 0.5,
    readUsage: async (credential, signal) => {
      observedCredentials.push(credential);
      observedSignals.push(signal);
      await readGate;
      if (readError !== undefined) throw readError;
      if (readsFail) throw new Error("network unavailable");
      return { usedPercent: 63.4, resetsAt: 2_000_000 };
    },
    startPolling: () => {
      pollingStarted += 1;
      return () => {
        pollingStopped += 1;
      };
    },
  });

  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const colors: string[] = [];
  const ctx = {
    mode: "tui",
    modelRegistry: {
      getProviderAuth: async () => {
        authReads += 1;
        if (!authEnabled) return undefined;
        return {
          auth: {
            apiKey: "secret",
            headers: { "chatgpt-account-id": accountId },
          },
          source: "OAuth",
        };
      },
    },
    ui: {
      theme: {
        fg: (color: string, text: string) => {
          colors.push(color);
          return text;
        },
      },
      setStatus: (key: string, text: string | undefined) =>
        statuses.push({ key, text }),
    },
  } as unknown as ExtensionContext;

  return {
    authReads: () => authReads,
    colors,
    ctx,
    handlers,
    observedCredentials,
    observedSignals,
    pollingStarted: () => pollingStarted,
    pollingStopped: () => pollingStopped,
    setAccountId: (value: string) => {
      accountId = value;
    },
    setAuthEnabled: (value: boolean) => {
      authEnabled = value;
    },
    setNow: (value: number) => {
      now = value;
    },
    setReadError: (value: Error | undefined) => {
      readError = value;
    },
    setReadGate: (value: Promise<void> | undefined) => {
      readGate = value;
    },
    setReadsFail: (value: boolean) => {
      readsFail = value;
    },
    statuses,
  };
}

async function emit(
  fixture: ReturnType<typeof registerFixture>,
  event: string,
  payload: unknown = {},
): Promise<void> {
  for (const handler of fixture.handlers.get(event) ?? []) {
    await handler(payload, fixture.ctx);
  }
}

test("session start shows loading then the active Codex account weekly usage", async () => {
  const fixture = registerFixture();

  await emit(fixture, "session_start");

  assert.deepEqual(fixture.statuses, [
    { key: "pi-usage", text: "Codex wk loading…" },
    { key: "pi-usage", text: "Codex wk ━━━━━━──── 63%" },
  ]);
  assert.deepEqual(fixture.observedCredentials, [
    { accessToken: "secret", accountId: "account-1" },
  ]);
  assert.equal(fixture.colors.at(-1), "dim");
});

test("missing Codex OAuth clears the status without starting polling", async () => {
  const fixture = registerFixture();
  fixture.setAuthEnabled(false);

  await emit(fixture, "session_start");

  assert.deepEqual(fixture.statuses, [
    { key: "pi-usage", text: "Codex wk loading…" },
    { key: "pi-usage", text: undefined },
  ]);
  assert.equal(fixture.pollingStarted(), 0);
});

test("polling starts with the session and stops on shutdown", async () => {
  const fixture = registerFixture();

  await emit(fixture, "session_start");
  await emit(fixture, "session_shutdown");

  assert.deepEqual(
    { started: fixture.pollingStarted(), stopped: fixture.pollingStopped() },
    { started: 1, stopped: 1 },
  );
});

test("agent settlement is debounced while the usage observation is fresh", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");

  await emit(fixture, "agent_settled");

  assert.equal(fixture.observedCredentials.length, 1);
});

test("a failed refresh immediately marks the last good usage as stale", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setReadsFail(true);

  await emit(fixture, "model_select");

  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk ━━━━━━──── 63% ~",
  });
});

test("usage older than ten minutes is unavailable after a failed refresh", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setReadsFail(true);
  fixture.setNow(1_600_001);

  await emit(fixture, "agent_settled");

  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk unavailable",
  });
});

test("Codex response headers opportunistically replace the displayed usage", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");

  await emit(fixture, "after_provider_response", {
    headers: {
      "x-codex-secondary-used-percent": "82",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "4000",
    },
  });

  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk ━━━━━━━━── 82%",
  });
  assert.equal(fixture.colors.at(-1), "warning");
});

test("overlapping refresh triggers share one in-flight request", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  let release: (() => void) | undefined;
  fixture.setReadGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );

  const refreshes = [
    emit(fixture, "agent_settled"),
    emit(fixture, "model_select"),
  ];
  await new Promise<void>((resolve) => setImmediate(resolve));
  release?.();
  await Promise.all(refreshes);

  assert.equal(fixture.observedCredentials.length, 2);
});

test("session shutdown aborts an in-flight usage request", async () => {
  const fixture = registerFixture();
  let release: (() => void) | undefined;
  fixture.setReadGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );

  const starting = emit(fixture, "session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await emit(fixture, "session_shutdown");

  assert.equal(fixture.observedSignals.at(-1)?.aborted, true);
  release?.();
  await starting;
});

test("Retry-After suppresses refreshes until the provider permits them", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setReadError(new CodexUsageRequestError(429, "120"));

  await emit(fixture, "agent_settled");
  await emit(fixture, "model_select");
  fixture.setNow(1_120_001);
  await emit(fixture, "model_select");

  assert.equal(fixture.observedCredentials.length, 3);
});

test("temporary failures apply exponential backoff before another refresh", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setReadsFail(true);

  await emit(fixture, "agent_settled");
  await emit(fixture, "model_select");
  fixture.setNow(1_001_001);
  await emit(fixture, "model_select");

  assert.equal(fixture.observedCredentials.length, 3);
});

test("authentication failures resolve Pi auth again and retry once", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setReadError(new CodexUsageRequestError(401, undefined));

  await emit(fixture, "model_select");

  assert.deepEqual(
    {
      authReads: fixture.authReads(),
      usageReads: fixture.observedCredentials.length,
    },
    { authReads: 3, usageReads: 3 },
  );
});

test("an account change discards the previous account usage before refreshing", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setAccountId("account-2");
  fixture.setReadsFail(true);

  await emit(fixture, "model_select");

  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk unavailable",
  });
});
