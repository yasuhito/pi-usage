import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, TestClock } from "effect";

import { makeClaudeProviderMonitor } from "../src/claude-provider-monitor.ts";
import { makeCodexProviderMonitor } from "../src/codex-provider-monitor.ts";
import { TemporaryAcquisitionFailure } from "../src/dedicated-weekly-quota-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "../src/presentation.ts";

const codexWeeklyQuotaUsage = {
  usedPercent: 20,
  resetsAtMs: 2_000_000,
  windowPosition: "secondary" as const,
};
const claudeSubscriptionUsage = {
  usedPercent: 80,
  resetsAtMs: 2_000_000,
  credentialFingerprint: "claude-1",
};

it.scoped("polls providers independently while one provider is delayed", () =>
  Effect.gen(function* () {
    let codexReads = 0;
    let claudeReads = 0;
    let claudeAcquisition = Effect.succeed(claudeSubscriptionUsage);
    const claudeGate = yield* Deferred.make<void>();
    const codexStatuses: WeeklySubscriptionUsageStatus[] = [];
    const claudeStatuses: WeeklySubscriptionUsageStatus[] = [];
    const codex = yield* makeCodexProviderMonitor({
      resolveCredential: Effect.succeed({
        kind: "available" as const,
        credential: { accessToken: "codex-token", accountId: "codex-1" },
      }),
      acquireDedicatedWeeklyQuotaUsage: () => {
        codexReads += 1;
        return Effect.succeed(codexWeeklyQuotaUsage);
      },
      publish: (status) =>
        Effect.sync(() => {
          codexStatuses.push(status);
        }),
    });
    const claude = yield* makeClaudeProviderMonitor({
      resolveCredentialIdentity: Effect.succeed({
        kind: "available" as const,
        fingerprint: "claude-1",
      }),
      acquireClaudeSubscriptionUsage: () => {
        claudeReads += 1;
        return claudeAcquisition;
      },
      publish: (status) =>
        Effect.sync(() => {
          claudeStatuses.push(status);
        }),
    });

    yield* Effect.all([codex.start, claude.start], {
      concurrency: "unbounded",
    });
    claudeAcquisition = Deferred.await(claudeGate).pipe(
      Effect.as(claudeSubscriptionUsage),
    );
    yield* TestClock.adjust("1 minute");
    assert.deepEqual([codexReads, claudeReads], [2, 2]);
    yield* TestClock.adjust("1 minute");
    assert.deepEqual([codexReads, claudeReads], [3, 2]);
    assert.deepEqual(codexStatuses.at(-1), {
      kind: "available",
      usedPercent: 20,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    });
    assert.deepEqual(claudeStatuses.at(-1), {
      kind: "available",
      usedPercent: 80,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    });
    yield* Deferred.succeed(claudeGate, undefined);
  }),
);

it.scoped("one provider's retry deadline does not delay the other", () =>
  Effect.gen(function* () {
    let codexReads = 0;
    let claudeReads = 0;
    const claudeStatuses: WeeklySubscriptionUsageStatus[] = [];
    const codex = yield* makeCodexProviderMonitor({
      resolveCredential: Effect.succeed({
        kind: "available" as const,
        credential: { accessToken: "codex-token", accountId: "codex-1" },
      }),
      acquireDedicatedWeeklyQuotaUsage: () => {
        codexReads += 1;
        return Effect.fail(
          new TemporaryAcquisitionFailure({ retryAtMs: 150_000 }),
        );
      },
      publish: () => Effect.void,
    });
    const claude = yield* makeClaudeProviderMonitor({
      resolveCredentialIdentity: Effect.succeed({
        kind: "available" as const,
        fingerprint: "claude-1",
      }),
      acquireClaudeSubscriptionUsage: () => {
        claudeReads += 1;
        return Effect.succeed(claudeSubscriptionUsage);
      },
      publish: (status) =>
        Effect.sync(() => {
          claudeStatuses.push(status);
        }),
    });

    yield* Effect.all([codex.start, claude.start], {
      concurrency: "unbounded",
    });
    yield* TestClock.adjust("2 minutes");
    assert.deepEqual([codexReads, claudeReads], [1, 3]);
    assert.deepEqual(claudeStatuses.at(-1), {
      kind: "available",
      usedPercent: 80,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    });
    yield* TestClock.adjust("29999 millis");
    assert.equal(codexReads, 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(codexReads, 2);
  }),
);

it.scoped("a Codex defect does not stop or alter Claude", () =>
  Effect.gen(function* () {
    let codexReads = 0;
    let claudeReads = 0;
    const claudeStatuses: WeeklySubscriptionUsageStatus[] = [];
    const codex = yield* makeCodexProviderMonitor({
      resolveCredential: Effect.succeed({
        kind: "available" as const,
        credential: { accessToken: "codex-token", accountId: "codex-1" },
      }),
      acquireDedicatedWeeklyQuotaUsage: () => {
        codexReads += 1;
        return Effect.die("codex defect");
      },
      publish: () => Effect.void,
      random: Effect.succeed(0.5),
    });
    const claude = yield* makeClaudeProviderMonitor({
      resolveCredentialIdentity: Effect.succeed({
        kind: "available" as const,
        fingerprint: "claude-1",
      }),
      acquireClaudeSubscriptionUsage: () => {
        claudeReads += 1;
        return Effect.succeed(claudeSubscriptionUsage);
      },
      publish: (status) =>
        Effect.sync(() => {
          claudeStatuses.push(status);
        }),
    });

    yield* Effect.all([codex.start, claude.start], {
      concurrency: "unbounded",
    });
    assert.deepEqual([codexReads, claudeReads], [1, 1]);
    assert.deepEqual(claudeStatuses.at(-1), {
      kind: "available",
      usedPercent: 80,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    });
    yield* TestClock.adjust("1 minute");
    assert.equal(claudeReads, 2);
    assert.deepEqual(claudeStatuses.at(-1), {
      kind: "available",
      usedPercent: 80,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    });
  }),
);

it.scoped("a Claude interruption does not stop or alter Codex", () =>
  Effect.gen(function* () {
    let codexReads = 0;
    let claudeReads = 0;
    const codexStatuses: WeeklySubscriptionUsageStatus[] = [];
    const codex = yield* makeCodexProviderMonitor({
      resolveCredential: Effect.succeed({
        kind: "available" as const,
        credential: { accessToken: "codex-token", accountId: "codex-1" },
      }),
      acquireDedicatedWeeklyQuotaUsage: () => {
        codexReads += 1;
        return Effect.succeed(codexWeeklyQuotaUsage);
      },
      publish: (status) =>
        Effect.sync(() => {
          codexStatuses.push(status);
        }),
    });
    const claude = yield* makeClaudeProviderMonitor({
      resolveCredentialIdentity: Effect.succeed({
        kind: "available" as const,
        fingerprint: "claude-1",
      }),
      acquireClaudeSubscriptionUsage: () => {
        claudeReads += 1;
        return Effect.interrupt;
      },
      publish: () => Effect.void,
    });

    yield* Effect.all([codex.start, claude.start], {
      concurrency: "unbounded",
    });
    assert.deepEqual([codexReads, claudeReads], [1, 1]);
    assert.deepEqual(codexStatuses.at(-1), {
      kind: "available",
      usedPercent: 20,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    });
    yield* TestClock.adjust("1 minute");
    assert.equal(codexReads, 2);
    assert.deepEqual(codexStatuses.at(-1), {
      kind: "available",
      usedPercent: 20,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    });
  }),
);
