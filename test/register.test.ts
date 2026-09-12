import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { test } from "vitest";

import {
  type AcquiredClaudeSubscriptionUsage,
  ClaudeAuthenticationUnavailable,
  claudeCredentialFingerprint,
  PermanentClaudeSubscriptionUsageFailure,
} from "../src/claude-subscription-usage-acquisition.ts";
import {
  type AcquiredWeeklyQuotaUsage,
  type CodexCredential,
  type DedicatedWeeklyQuotaAcquisitionError,
  TemporaryAcquisitionFailure,
} from "../src/dedicated-weekly-quota-acquisition.ts";
import { registerWeeklySubscriptionUsage } from "../src/register.ts";

function accessTokenFor(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function anthropicCredentialFingerprint(accountId = "account-1"): string {
  const fingerprint = claudeCredentialFingerprint({
    source: "OAuth",
    auth: { apiKey: accessTokenFor(accountId) },
  });
  assert.ok(fingerprint);
  return fingerprint;
}

type ExtensionHandler = (
  event: { readonly headers?: Readonly<Record<string, unknown>> },
  ctx: ExtensionContext,
) => void | Promise<void>;

function registerFixture() {
  const handlers = new Map<string, ExtensionHandler[]>();
  const pi = {
    on(event: string, handler: ExtensionHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const observedCredentials: CodexCredential[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  let mode: ExtensionContext["mode"] = "tui";
  let provider = "openai-codex";
  let authEnabled = true;
  let accountId = "account-1";
  let authWait: Promise<void> | undefined;
  let showThemeColors = false;
  let now: Effect.Effect<number> = Effect.succeed(1_000_000);
  let acquisition: Effect.Effect<
    AcquiredWeeklyQuotaUsage,
    DedicatedWeeklyQuotaAcquisitionError
  > = Effect.succeed({
    usedPercent: 63.4,
    resetsAtMs: 2_000_000,
    windowPosition: "secondary",
    availableLimitResetCredits: 2,
  });
  let claudeReads = 0;
  let claudeAcquisition: Effect.Effect<
    AcquiredClaudeSubscriptionUsage,
    PermanentClaudeSubscriptionUsageFailure | ClaudeAuthenticationUnavailable
  > = Effect.succeed({
    usedPercent: 80,
    resetsAtMs: 2_000_000,
    credentialFingerprint: anthropicCredentialFingerprint(),
  });

  registerWeeklySubscriptionUsage(pi, {
    now: Effect.suspend(() => now),
    random: Effect.succeed(0.5),
    acquireDedicatedWeeklyQuotaUsage: (credential) => {
      observedCredentials.push(credential);
      return acquisition;
    },
    acquireClaudeSubscriptionUsage: () => () => {
      claudeReads += 1;
      return claudeAcquisition;
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
      getProviderAuth: async (providerName: string) => {
        await authWait;
        return providerName !== "openai-codex" || authEnabled
          ? {
              auth: { apiKey: accessTokenFor(accountId) },
              source: "OAuth" as const,
            }
          : undefined;
      },
    },
    ui: {
      theme: {
        fg: (color: string, text: string) =>
          showThemeColors ? `[${color}:${text}]` : text,
      },
      setStatus: (key: string, text: string | undefined) =>
        statuses.push({ key, text }),
    },
  } as unknown as ExtensionContext;
  const emit = async (event: string, payload: unknown = {}) => {
    for (const handler of handlers.get(event) ?? [])
      await handler(
        payload as { readonly headers?: Readonly<Record<string, unknown>> },
        ctx,
      );
  };
  return {
    emit,
    observedCredentials,
    claudeReads: () => claudeReads,
    statuses,
    setMode: (value: ExtensionContext["mode"]) => {
      mode = value;
    },
    setProvider: (value: string) => {
      provider = value;
    },
    setAuthEnabled: (value: boolean) => {
      authEnabled = value;
    },
    setAccountId: (value: string) => {
      accountId = value;
    },
    setAuthWait: (value: Promise<void> | undefined) => {
      authWait = value;
    },
    setShowThemeColors: (value: boolean) => {
      showThemeColors = value;
    },
    setNow: (value: Effect.Effect<number>) => {
      now = value;
    },
    setAcquisition: (value: typeof acquisition) => {
      acquisition = value;
    },
    setClaudeAcquisition: (value: typeof claudeAcquisition) => {
      claudeAcquisition = value;
    },
  };
}

test("session start adapts Pi authentication and quota presentation", async () => {
  const f = registerFixture();
  await f.emit("session_start");
  assert.deepEqual(f.observedCredentials, [
    { accessToken: accessTokenFor("account-1"), accountId: "account-1" },
  ]);
  assert.deepEqual(f.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk ━━━━━━──── 63% · reset 16m · ↻2 Claude wk ━━━━━━━━── 80% · reset 16m",
  });
  await f.emit("session_shutdown");
});

test("missing Codex authentication remains unavailable without delaying Claude", async () => {
  const f = registerFixture();
  f.setAuthEnabled(false);
  await f.emit("session_start");
  assert.deepEqual(f.statuses.at(-1), {
    key: "pi-usage",
    text: "Codex wk unavailable Claude wk ━━━━━━━━── 80% · reset 16m",
  });
  assert.equal(f.observedCredentials.length, 0);
  await f.emit("session_shutdown");
});

test("direct Codex activity refreshes Codex without refreshing Claude", async () => {
  const f = registerFixture();
  f.setAuthEnabled(false);
  await f.emit("session_start");
  assert.deepEqual([f.observedCredentials.length, f.claudeReads()], [0, 1]);
  f.setAuthEnabled(true);
  await f.emit("agent_settled");
  assert.deepEqual([f.observedCredentials.length, f.claudeReads()], [1, 1]);
  await f.emit("session_shutdown");
});

test("provider names and independently colored details compose without a separator", async () => {
  const f = registerFixture();
  f.setShowThemeColors(true);
  await f.emit("session_start");
  assert.equal(
    f.statuses.at(-1)?.text,
    "[accent:Codex] [dim:wk ━━━━━━──── 63% · reset 16m · ↻2] [accent:Claude] [warning:wk ━━━━━━━━── 80% · reset 16m]",
  );
  await f.emit("session_shutdown");
});

test("a failed provider remains independently presentable", async () => {
  const f = registerFixture();
  f.setClaudeAcquisition(
    Effect.fail(new PermanentClaudeSubscriptionUsageFailure()),
  );
  await f.emit("session_start");
  assert.equal(
    f.statuses.at(-1)?.text,
    "Codex wk ━━━━━━──── 63% · reset 16m · ↻2 Claude wk unavailable",
  );
  await f.emit("session_shutdown");
});

test("a provider defect does not reorder or recolor the other provider", async () => {
  const f = registerFixture();
  f.setShowThemeColors(true);
  f.setClaudeAcquisition(Effect.die("Claude acquisition defect"));
  await f.emit("session_start");
  assert.equal(
    f.statuses.at(-1)?.text,
    "[accent:Codex] [dim:wk ━━━━━━──── 63% · reset 16m · ↻2] [accent:Claude] [dim:wk unavailable]",
  );
  await f.emit("session_shutdown");
});

test("shutdown interrupts an active exchange after the other provider publishes", async () => {
  const f = registerFixture();
  let finalized = 0;
  f.setClaudeAcquisition(
    Effect.never.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          finalized += 1;
        }),
      ),
    ),
  );
  const start = f.emit("session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    f.statuses.at(-1)?.text,
    "Codex wk ━━━━━━──── 63% · reset 16m · ↻2 Claude wk loading…",
  );
  await f.emit("session_shutdown");
  await start;
  assert.equal(finalized, 1);
});

test("shutdown suppresses a publication already suspended inside the Pi UI boundary", async () => {
  const f = registerFixture();
  await f.emit("session_start");
  const statusesBeforeRefresh = f.statuses.length;
  let releaseNow!: (now: number) => void;
  const delayedNow = new Promise<number>((resolve) => {
    releaseNow = resolve;
  });
  f.setNow(Effect.uninterruptible(Effect.promise(() => delayedNow)));
  const refresh = f.emit("after_provider_response", {
    headers: {
      "x-codex-primary-used-percent": "20",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": "2000",
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const shutdown = f.emit("session_shutdown");
  releaseNow(1_000_000);
  await Promise.all([refresh, shutdown]);

  assert.equal(f.statuses.length, statusesBeforeRefresh);
});

test("shutdown interrupts credential resolution and ignores its late completion", async () => {
  const f = registerFixture();
  let releaseAuth!: () => void;
  const delayedAuth = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  f.setAuthWait(delayedAuth);

  const start = f.emit("session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const publicationsBeforeShutdown = f.statuses.length;
  await f.emit("session_shutdown");
  releaseAuth();
  await start;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(f.observedCredentials.length, 0);
  assert.equal(f.claudeReads(), 0);
  assert.equal(f.statuses.length, publicationsBeforeShutdown);
});

test("shutdown cancels scheduled retry and stale-expiration work", async () => {
  const f = registerFixture();
  f.setAcquisition(
    Effect.succeed({
      usedPercent: 20,
      resetsAtMs: Date.now() + 100,
      windowPosition: "secondary",
    }),
  );
  await f.emit("session_start");
  f.setAcquisition(
    Effect.fail(
      new TemporaryAcquisitionFailure({ retryAtMs: Date.now() + 30 }),
    ),
  );
  await f.emit("model_select");
  const readsBeforeShutdown = f.observedCredentials.length;
  const publicationsBeforeShutdown = f.statuses.length;

  await f.emit("session_shutdown");
  await new Promise<void>((resolve) => setTimeout(resolve, 150));

  assert.equal(f.observedCredentials.length, readsBeforeShutdown);
  assert.equal(f.statuses.length, publicationsBeforeShutdown);
});

test("non-TUI sessions remain inactive for every Pi lifecycle event", async () => {
  const f = registerFixture();
  f.setMode("rpc");
  await f.emit("session_start");
  await f.emit("model_select");
  await f.emit("agent_settled");
  await f.emit("after_provider_response", {
    headers: {
      "x-codex-primary-used-percent": "20",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": "2000",
    },
  });
  await f.emit("session_shutdown");
  assert.equal(f.observedCredentials.length, 0);
  assert.equal(f.claudeReads(), 0);
  assert.equal(f.statuses.length, 0);
});

test("activity refreshes only the direct provider that handled it", async () => {
  const f = registerFixture();
  f.setClaudeAcquisition(Effect.fail(new ClaudeAuthenticationUnavailable()));
  await f.emit("session_start");
  assert.equal(f.observedCredentials.length, 1);
  assert.equal(f.claudeReads(), 1);

  f.setClaudeAcquisition(
    Effect.succeed({
      usedPercent: 20,
      resetsAtMs: 2_000_000,
      credentialFingerprint: anthropicCredentialFingerprint(),
    }),
  );
  f.setProvider("anthropic");
  await f.emit("agent_settled");
  assert.equal(f.observedCredentials.length, 1);
  assert.equal(f.claudeReads(), 2);

  f.setProvider("openrouter");
  await f.emit("agent_settled");
  assert.equal(f.observedCredentials.length, 1);
  assert.equal(f.claudeReads(), 2);
  await f.emit("session_shutdown");
});

test("responses from another provider are ignored", async () => {
  const f = registerFixture();
  await f.emit("session_start");
  f.setProvider("anthropic");
  await f.emit("after_provider_response", {
    headers: { "x-codex-secondary-used-percent": "99" },
  });
  assert.equal(
    f.statuses.at(-1)?.text,
    "Codex wk ━━━━━━──── 63% · reset 16m · ↻2 Claude wk ━━━━━━━━── 80% · reset 16m",
  );
  await f.emit("session_shutdown");
});

test("model selection clears previous-account usage and suppresses late exchange completion", async () => {
  const f = registerFixture();
  await f.emit("session_start");
  let completeOldCodex!: (usage: AcquiredWeeklyQuotaUsage) => void;
  let completeOldClaude!: (usage: AcquiredClaudeSubscriptionUsage) => void;
  const oldCodex = new Promise<AcquiredWeeklyQuotaUsage>((resolve) => {
    completeOldCodex = resolve;
  });
  const oldClaude = new Promise<AcquiredClaudeSubscriptionUsage>((resolve) => {
    completeOldClaude = resolve;
  });
  f.setAcquisition(Effect.promise(() => oldCodex));
  f.setClaudeAcquisition(Effect.promise(() => oldClaude));

  const oldAccountRefresh = f.emit("model_select");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (f.observedCredentials.length === 2 && f.claudeReads() === 2) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  f.setAccountId("account-2");
  f.setAcquisition(
    Effect.succeed({
      usedPercent: 20,
      resetsAtMs: 2_000_000,
      windowPosition: "secondary",
    }),
  );
  f.setClaudeAcquisition(
    Effect.succeed({
      usedPercent: 30,
      resetsAtMs: 2_000_000,
      credentialFingerprint: anthropicCredentialFingerprint("account-2"),
    }),
  );
  const publicationsBeforeAccountChange = f.statuses.length;
  await f.emit("model_select");

  const accountChangePublications = f.statuses.slice(
    publicationsBeforeAccountChange,
  );
  assert.ok(
    accountChangePublications.some((publication) =>
      publication.text?.startsWith("Codex wk unavailable"),
    ),
  );
  assert.ok(
    accountChangePublications.some((publication) =>
      publication.text?.includes("Claude wk unavailable"),
    ),
  );
  assert.deepEqual(f.observedCredentials.at(-1), {
    accessToken: accessTokenFor("account-2"),
    accountId: "account-2",
  });
  assert.equal(
    f.statuses.at(-1)?.text,
    "Codex wk ━━──────── 20% · reset 16m Claude wk ━━━─────── 30% · reset 16m",
  );
  const publicationsAfterAccountChange = f.statuses.length;

  completeOldCodex({
    usedPercent: 99,
    resetsAtMs: 2_000_000,
    windowPosition: "secondary",
  });
  completeOldClaude({
    usedPercent: 99,
    resetsAtMs: 2_000_000,
    credentialFingerprint: anthropicCredentialFingerprint(),
  });
  await oldAccountRefresh;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(f.statuses.length, publicationsAfterAccountChange);
  await f.emit("session_shutdown");
});

test("repeated session start closes the previous Scope and suppresses late publication", async () => {
  const f = registerFixture();
  let finalized = 0;
  let releasePreviousSession!: () => void;
  const previousSessionGate = new Promise<void>((resolve) => {
    releasePreviousSession = resolve;
  });
  const countFinalization = Effect.sync(() => {
    finalized += 1;
  });
  f.setAcquisition(
    Effect.uninterruptible(Effect.promise(() => previousSessionGate)).pipe(
      Effect.as({
        usedPercent: 99,
        resetsAtMs: 2_000_000,
        windowPosition: "secondary" as const,
      }),
      Effect.ensuring(countFinalization),
    ),
  );
  f.setClaudeAcquisition(
    Effect.uninterruptible(Effect.promise(() => previousSessionGate)).pipe(
      Effect.as({
        usedPercent: 99,
        resetsAtMs: 2_000_000,
        credentialFingerprint: anthropicCredentialFingerprint(),
      }),
      Effect.ensuring(countFinalization),
    ),
  );
  const first = f.emit("session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.setAcquisition(
    Effect.succeed({
      usedPercent: 20,
      resetsAtMs: 2_000_000,
      windowPosition: "secondary",
    }),
  );
  f.setClaudeAcquisition(
    Effect.succeed({
      usedPercent: 80,
      resetsAtMs: 2_000_000,
      credentialFingerprint: anthropicCredentialFingerprint(),
    }),
  );
  const replacement = f.emit("session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finalized, 0);
  assert.notEqual(
    f.statuses.at(-1)?.text,
    "Codex wk ━━──────── 20% · reset 16m Claude wk ━━━━━━━━── 80% · reset 16m",
  );

  releasePreviousSession();
  await Promise.all([first, replacement]);
  assert.equal(finalized, 2);
  assert.equal(
    f.statuses.at(-1)?.text,
    "Codex wk ━━──────── 20% · reset 16m Claude wk ━━━━━━━━── 80% · reset 16m",
  );
  await f.emit("session_shutdown");
});
