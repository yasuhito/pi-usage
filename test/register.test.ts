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
  const observedSignals: Array<AbortSignal | undefined> = [];
  let accountId = "account-1";
  let authEnabled = true;
  let authReads = 0;
  let pollingStarted = 0;
  let pollingStopped = 0;
  let scheduledExpiration: (() => void) | undefined;
  let scheduledExpirationDelay: number | undefined;
  let readsFail = false;
  let disableAuthAfterUsageReads: number | undefined;
  let readError: Error | undefined;
  let readGate: Promise<void> | undefined;
  let now = 1_000_000;
  let modelProvider = "openai-codex";

  registerWeeklyQuotaUsage(pi, {
    now: () => now,
    random: () => 0.5,
    schedule: (callback, delay) => {
      scheduledExpiration = callback;
      scheduledExpirationDelay = delay;
      return () => {
        scheduledExpiration = undefined;
      };
    },
    readWeeklyQuotaUsage: async (credential, signal) => {
      observedCredentials.push(credential);
      observedSignals.push(signal);
      if (observedCredentials.length === disableAuthAfterUsageReads) {
        authEnabled = false;
      }
      await readGate;
      if (readError !== undefined) throw readError;
      if (readsFail) throw new Error("network unavailable");
      return {
        usedPercent: 63.4,
        resetsAtMs: 2_000_000,
        windowPosition: "secondary",
      };
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
    get model() {
      return { provider: modelProvider };
    },
    modelRegistry: {
      getProviderAuth: async () => {
        authReads += 1;
        if (!authEnabled) return undefined;
        return {
          auth: {
            apiKey: accessTokenFor(accountId),
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
    runScheduledExpiration: () => scheduledExpiration?.(),
    scheduledExpirationDelay: () => scheduledExpirationDelay,
    setAccountId: (value: string) => {
      accountId = value;
    },
    setDisableAuthAfterUsageReads: (value: number | undefined) => {
      disableAuthAfterUsageReads = value;
    },
    setAuthEnabled: (value: boolean) => {
      authEnabled = value;
    },
    setModelProvider: (value: string) => {
      modelProvider = value;
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
    { accessToken: accessTokenFor("account-1"), accountId: "account-1" },
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

test("malformed configured Codex OAuth is displayed as unavailable", async () => {
  const fixture = registerFixture();
  fixture.setAccountId("");

  await emit(fixture, "session_start");

  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk unavailable",
  });
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

test("a failed refresh immediately marks the last observed usage as stale", async () => {
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

test("an empty later response cannot replay accumulated headers as fresh", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  await emit(fixture, "after_provider_response", {
    headers: {
      "x-codex-secondary-used-percent": "82",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "4000",
    },
  });
  const statusCount = fixture.statuses.length;

  await emit(fixture, "after_provider_response", { headers: {} });

  assert.equal(fixture.statuses.length, statusCount);
});

test("response headers from another active provider cannot replace Codex usage", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setModelProvider("anthropic");

  await emit(fixture, "after_provider_response", {
    headers: {
      "x-codex-secondary-used-percent": "99",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "4000",
    },
  });

  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk ━━━━━━──── 63%",
  });
});

test("a Codex response without usage headers refreshes an old observation", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setNow(1_031_000);

  await emit(fixture, "after_provider_response", { headers: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fixture.observedCredentials.length, 2);
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

test("a forced refresh queued behind a request cannot start after shutdown", async () => {
  const fixture = registerFixture();
  let release: (() => void) | undefined;
  fixture.setReadGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );

  const starting = emit(fixture, "session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const queued = emit(fixture, "model_select");
  await emit(fixture, "session_shutdown");
  release?.();
  await Promise.all([starting, queued]);

  assert.deepEqual(
    {
      pollingStarted: fixture.pollingStarted(),
      usageReads: fixture.observedCredentials.length,
    },
    { pollingStarted: 0, usageReads: 1 },
  );
});

test("Retry-After suppresses refreshes until the provider permits them", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setReadError(new CodexUsageRequestError(429, "120"));
  fixture.setNow(1_031_000);

  await emit(fixture, "agent_settled");
  await emit(fixture, "agent_settled");
  fixture.setNow(1_151_001);
  await emit(fixture, "agent_settled");

  assert.equal(fixture.observedCredentials.length, 3);
});

test("stale usage expires even while Retry-After suppresses requests", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setReadError(new CodexUsageRequestError(429, "1200"));
  await emit(fixture, "model_select");
  fixture.setNow(2_000_001);

  await emit(fixture, "agent_settled");

  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk unavailable",
  });
});

test("model selection bypasses old-account backoff to resolve current auth", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setReadError(new CodexUsageRequestError(429, "120"));
  await emit(fixture, "model_select");
  fixture.setAccountId("account-2");

  await emit(fixture, "model_select");

  assert.deepEqual(fixture.observedCredentials.at(-1), {
    accessToken: accessTokenFor("account-2"),
    accountId: "account-2",
  });
});

test("temporary failures apply exponential backoff before another refresh", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setReadsFail(true);
  fixture.setNow(1_031_000);

  await emit(fixture, "model_select");
  await emit(fixture, "agent_settled");
  fixture.setNow(1_032_001);
  await emit(fixture, "agent_settled");

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

test("logout discovered during auth retry clears status and polling", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setReadError(new CodexUsageRequestError(401, undefined));
  fixture.setDisableAuthAfterUsageReads(2);

  await emit(fixture, "model_select");

  assert.deepEqual(
    {
      pollingStopped: fixture.pollingStopped(),
      status: fixture.statuses.at(-1),
    },
    {
      pollingStopped: 1,
      status: { key: "pi-usage", text: undefined },
    },
  );
});

test("a stale observation schedules removal at its earliest deadline", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setReadsFail(true);

  await emit(fixture, "model_select");

  assert.equal(fixture.scheduledExpirationDelay(), 600_000);
  fixture.setNow(1_600_000);
  fixture.runScheduledExpiration();
  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk unavailable",
  });
});

test("sparse Codex headers accumulate across provider responses", async () => {
  const fixture = registerFixture();
  fixture.setReadsFail(true);
  await emit(fixture, "session_start");

  await emit(fixture, "after_provider_response", {
    headers: { "x-codex-secondary-window-minutes": "10080" },
  });
  await emit(fixture, "after_provider_response", {
    headers: {
      "x-codex-secondary-used-percent": "74",
      "x-codex-secondary-reset-at": "4000",
    },
  });

  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk ━━━━━━━─── 74%",
  });
});

test("malformed recognized Codex headers make usage unavailable", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");

  await emit(fixture, "after_provider_response", {
    headers: {
      "x-codex-secondary-used-percent": " ",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "4000",
    },
  });

  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk unavailable",
  });
});

test("permanent request failures do not present old usage as stale", async () => {
  const fixture = registerFixture();
  await emit(fixture, "session_start");
  fixture.setReadError(new CodexUsageRequestError(400, undefined));

  await emit(fixture, "model_select");

  assert.deepEqual(fixture.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk unavailable",
  });
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
