import assert from "node:assert/strict";
import { Effect } from "effect";
import { test } from "vitest";

import type { AcquiredClaudeSubscriptionUsage } from "../src/claude-subscription-usage-acquisition.ts";
import {
  type AcquiredWeeklyQuotaUsage,
  TemporaryAcquisitionFailure,
} from "../src/dedicated-weekly-quota-acquisition.ts";
import type {
  MonitoredProviderName,
  WeeklySubscriptionUsageStatus,
} from "../src/presentation.ts";
import {
  makeWeeklySubscriptionUsageSession,
  type WeeklySubscriptionUsageSessionDependencies,
} from "../src/weekly-subscription-usage-session.ts";

const codexUsage: AcquiredWeeklyQuotaUsage = {
  usedPercent: 20,
  resetsAtMs: 2_000_000,
  windowPosition: "secondary",
};
const claudeUsage: AcquiredClaudeSubscriptionUsage = {
  usedPercent: 80,
  resetsAtMs: 2_000_000,
  credentialFingerprint: "claude-1",
};

function sessionDependencies(
  options: {
    readonly acquireCodex?: Effect.Effect<AcquiredWeeklyQuotaUsage>;
    readonly acquireClaude?: Effect.Effect<AcquiredClaudeSubscriptionUsage>;
    readonly now?: Effect.Effect<number>;
    readonly present?: (
      statuses: Readonly<
        Record<MonitoredProviderName, WeeklySubscriptionUsageStatus>
      >,
    ) => void;
  } = {},
): WeeklySubscriptionUsageSessionDependencies {
  return {
    now: options.now ?? Effect.succeed(1_000_000),
    present: (statuses) =>
      Effect.sync(() => options.present?.(structuredClone(statuses))),
    codex: {
      resolveCredential: Effect.succeed({
        kind: "available",
        credential: { accessToken: "codex-token", accountId: "codex-1" },
      }),
      acquireDedicatedWeeklyQuotaUsage: () =>
        options.acquireCodex ?? Effect.succeed(codexUsage),
      random: Effect.succeed(0.5),
    },
    makeClaudeDependencies: () => ({
      resolveCredentialIdentity: Effect.succeed({
        kind: "available",
        fingerprint: "claude-1",
      }),
      acquireClaudeSubscriptionUsage: () =>
        options.acquireClaude ?? Effect.succeed(claudeUsage),
      random: Effect.succeed(0.5),
    }),
  };
}

test("shutdown interrupts active session work", async () => {
  const session = await Effect.runPromise(makeWeeklySubscriptionUsageSession());
  let finalized = 0;
  const presentations: Array<
    Readonly<Record<MonitoredProviderName, WeeklySubscriptionUsageStatus>>
  > = [];
  const start = Effect.runPromise(
    session.start(
      sessionDependencies({
        present: (statuses) => presentations.push(statuses),
        acquireClaude: Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized += 1;
            }),
          ),
        ),
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    presentations.some(
      (statuses) =>
        statuses.Codex.kind === "available" &&
        statuses.Claude.kind === "loading",
    ),
    true,
  );

  await Effect.runPromise(session.shutdown);
  await start;

  assert.equal(finalized, 1);
});

test("shutdown suppresses a publication suspended before presentation", async () => {
  const session = await Effect.runPromise(makeWeeklySubscriptionUsageSession());
  let now: Effect.Effect<number> = Effect.succeed(1_000_000);
  const presentations: unknown[] = [];
  await Effect.runPromise(
    session.start(
      sessionDependencies({
        now: Effect.suspend(() => now),
        present: (statuses) => presentations.push(statuses),
      }),
    ),
  );
  const presentationsBeforeRefresh = presentations.length;
  let releaseNow!: (value: number) => void;
  const delayedNow = new Promise<number>((resolve) => {
    releaseNow = resolve;
  });
  now = Effect.uninterruptible(Effect.promise(() => delayedNow));

  const refresh = Effect.runPromise(
    session.observeCodexResponse({
      "x-codex-primary-used-percent": "20",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": "2000",
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const shutdown = Effect.runPromise(session.shutdown);
  releaseNow(1_000_000);
  await Promise.all([refresh, shutdown]);

  assert.equal(presentations.length, presentationsBeforeRefresh);
});

test("shutdown interrupts credential resolution and ignores late completion", async () => {
  const session = await Effect.runPromise(makeWeeklySubscriptionUsageSession());
  let releaseCredential!: () => void;
  const credentialGate = new Promise<void>((resolve) => {
    releaseCredential = resolve;
  });
  let acquisitions = 0;
  const presentations: unknown[] = [];
  const dependencies = sessionDependencies({
    present: (statuses) => presentations.push(statuses),
  });
  const start = Effect.runPromise(
    session.start({
      ...dependencies,
      codex: {
        ...dependencies.codex,
        resolveCredential: Effect.promise(() => credentialGate).pipe(
          Effect.as({
            kind: "available" as const,
            credential: {
              accessToken: "codex-token",
              accountId: "codex-1",
            },
          }),
        ),
        acquireDedicatedWeeklyQuotaUsage: () => {
          acquisitions += 1;
          return Effect.succeed(codexUsage);
        },
      },
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const presentationsBeforeShutdown = presentations.length;

  await Effect.runPromise(session.shutdown);
  releaseCredential();
  await start;

  assert.equal(acquisitions, 0);
  assert.equal(presentations.length, presentationsBeforeShutdown);
});

test("shutdown cancels retry and stale-expiration work", async () => {
  const session = await Effect.runPromise(makeWeeklySubscriptionUsageSession());
  let codexReads = 0;
  let acquisition: Effect.Effect<
    AcquiredWeeklyQuotaUsage,
    TemporaryAcquisitionFailure
  > = Effect.succeed({ ...codexUsage, resetsAtMs: Date.now() + 100 });
  const presentations: unknown[] = [];
  const dependencies = sessionDependencies({
    present: (statuses) => presentations.push(statuses),
  });
  await Effect.runPromise(
    session.start({
      ...dependencies,
      codex: {
        ...dependencies.codex,
        acquireDedicatedWeeklyQuotaUsage: () => {
          codexReads += 1;
          return acquisition;
        },
      },
    }),
  );
  acquisition = Effect.fail(
    new TemporaryAcquisitionFailure({ retryAtMs: Date.now() + 30 }),
  );
  await Effect.runPromise(session.refreshForAccountChange);
  const readsBeforeShutdown = codexReads;
  const presentationsBeforeShutdown = presentations.length;

  await Effect.runPromise(session.shutdown);
  await new Promise<void>((resolve) => setTimeout(resolve, 150));

  assert.equal(codexReads, readsBeforeShutdown);
  assert.equal(presentations.length, presentationsBeforeShutdown);
});

test("a replacement waits for the previous Scope and suppresses its late publication", async () => {
  const session = await Effect.runPromise(makeWeeklySubscriptionUsageSession());
  let finalized = 0;
  let releasePrevious!: () => void;
  const previousGate = new Promise<void>((resolve) => {
    releasePrevious = resolve;
  });
  const countFinalization = Effect.sync(() => {
    finalized += 1;
  });
  const presentations: Array<
    Readonly<Record<MonitoredProviderName, WeeklySubscriptionUsageStatus>>
  > = [];
  const previousStart = Effect.runPromise(
    session.start(
      sessionDependencies({
        acquireCodex: Effect.uninterruptible(
          Effect.promise(() => previousGate),
        ).pipe(
          Effect.as({ ...codexUsage, usedPercent: 99 }),
          Effect.ensuring(countFinalization),
        ),
        acquireClaude: Effect.uninterruptible(
          Effect.promise(() => previousGate),
        ).pipe(
          Effect.as({ ...claudeUsage, usedPercent: 99 }),
          Effect.ensuring(countFinalization),
        ),
        present: (statuses) => presentations.push(statuses),
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const replacement = Effect.runPromise(
    session.start(
      sessionDependencies({
        present: (statuses) => presentations.push(statuses),
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finalized, 0);

  releasePrevious();
  await Promise.all([previousStart, replacement]);

  assert.equal(finalized, 2);
  assert.deepEqual(presentations.at(-1), {
    Codex: {
      kind: "available",
      usedPercent: 20,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    },
    Claude: {
      kind: "available",
      usedPercent: 80,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    },
  });
  assert.equal(
    presentations.some((statuses) =>
      Object.values(statuses).some(
        (status) => status.kind === "available" && status.usedPercent === 99,
      ),
    ),
    false,
  );
  await Effect.runPromise(session.shutdown);
});

test("only the latest queued start creates monitors and publishes", async () => {
  const session = await Effect.runPromise(makeWeeklySubscriptionUsageSession());
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const presentations: Array<
    Readonly<Record<MonitoredProviderName, WeeklySubscriptionUsageStatus>>
  > = [];
  const first = Effect.runPromise(
    session.start(
      sessionDependencies({
        acquireCodex: Effect.uninterruptible(
          Effect.promise(() => firstGate),
        ).pipe(Effect.as({ ...codexUsage, usedPercent: 99 })),
        acquireClaude: Effect.uninterruptible(
          Effect.promise(() => firstGate),
        ).pipe(Effect.as({ ...claudeUsage, usedPercent: 99 })),
        present: (statuses) => presentations.push(statuses),
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  let middleClaudeDependenciesCreated = 0;
  let middleCodexReads = 0;
  const middleDependencies = sessionDependencies({
    present: (statuses) => presentations.push(statuses),
  });
  const middle = Effect.runPromise(
    session.start({
      ...middleDependencies,
      codex: {
        ...middleDependencies.codex,
        acquireDedicatedWeeklyQuotaUsage: () => {
          middleCodexReads += 1;
          return Effect.succeed({ ...codexUsage, usedPercent: 50 });
        },
      },
      makeClaudeDependencies: () => {
        middleClaudeDependenciesCreated += 1;
        return middleDependencies.makeClaudeDependencies();
      },
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const latest = Effect.runPromise(
    session.start(
      sessionDependencies({
        acquireCodex: Effect.succeed({ ...codexUsage, usedPercent: 30 }),
        acquireClaude: Effect.succeed({ ...claudeUsage, usedPercent: 40 }),
        present: (statuses) => presentations.push(statuses),
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([first, middle, latest]);

  assert.equal(middleClaudeDependenciesCreated, 0);
  assert.equal(middleCodexReads, 0);
  assert.equal(
    presentations.some((statuses) =>
      Object.values(statuses).some(
        (status) => status.kind === "available" && status.usedPercent === 50,
      ),
    ),
    false,
  );
  assert.deepEqual(presentations.at(-1), {
    Codex: {
      kind: "available",
      usedPercent: 30,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    },
    Claude: {
      kind: "available",
      usedPercent: 40,
      stale: false,
      weeklyWindowResetsAtMs: 2_000_000,
    },
  });
  await Effect.runPromise(session.shutdown);
});
