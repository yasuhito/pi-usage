import assert from "node:assert/strict";
import { Effect, Layer } from "effect";
import { test } from "vitest";

import { claudeProviderMonitorLayer } from "../src/claude-provider-monitor.ts";
import {
  type AcquiredClaudeSubscriptionUsage,
  ClaudeAuthenticationUnavailable,
  type ClaudeSubscriptionUsageAcquisitionError,
} from "../src/claude-subscription-usage-acquisition.ts";
import {
  type CodexCredentialResolution,
  codexProviderMonitorLayer,
} from "../src/codex-provider-monitor.ts";
import {
  type AcquiredWeeklyQuotaUsage,
  type DedicatedWeeklyQuotaAcquisitionError,
  TemporaryAcquisitionFailure,
} from "../src/dedicated-weekly-quota-acquisition.ts";
import {
  defineMonitoredProvider,
  type MonitoredProviderCapacitySessionDependencies,
  makeMonitoredProviderCapacitySession,
} from "../src/monitored-provider-capacity-session.ts";
import {
  type OpenRouterKeyCapacityStatus,
  presentProviderSubscriptionUsage,
  type WeeklySubscriptionProviderName,
  type WeeklySubscriptionUsageStatus,
} from "../src/presentation.ts";
import { ProviderMonitorService } from "../src/provider-monitor.ts";

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

type CapacityRecord = Readonly<
  Record<WeeklySubscriptionProviderName, WeeklySubscriptionUsageStatus>
>;

function sessionDependencies(
  options: {
    readonly resolveCodex?: Effect.Effect<CodexCredentialResolution>;
    readonly acquireCodex?: () => Effect.Effect<
      AcquiredWeeklyQuotaUsage,
      DedicatedWeeklyQuotaAcquisitionError
    >;
    readonly acquireClaude?: Effect.Effect<
      AcquiredClaudeSubscriptionUsage,
      ClaudeSubscriptionUsageAcquisitionError
    >;
    readonly onMakeClaudeLayer?: () => void;
    readonly now?: Effect.Effect<number>;
    readonly present?: (statuses: CapacityRecord) => void;
  } = {},
): MonitoredProviderCapacitySessionDependencies {
  return {
    now: options.now ?? Effect.succeed(1_000_000),
    present: (capacities) =>
      Effect.sync(() => {
        const statuses = Object.fromEntries(
          capacities.map(({ presentation, status }) => [
            presentation.providerName,
            status,
          ]),
        ) as Record<
          WeeklySubscriptionProviderName,
          WeeklySubscriptionUsageStatus
        >;
        options.present?.(structuredClone(statuses));
      }),
    providers: [
      defineMonitoredProvider<WeeklySubscriptionUsageStatus>({
        piProviderId: "openai-codex",
        makeLayer: (publish) =>
          codexProviderMonitorLayer({
            resolveCredential:
              options.resolveCodex ??
              Effect.succeed({
                kind: "available" as const,
                credential: {
                  accessToken: "codex-token",
                  accountId: "codex-1",
                },
              }),
            acquireDedicatedWeeklyQuotaUsage: () =>
              options.acquireCodex?.() ?? Effect.succeed(codexUsage),
            publish,
            random: Effect.succeed(0.5),
          }),
        present: (status, nowMs) =>
          presentProviderSubscriptionUsage("Codex", status, nowMs),
      }),
      defineMonitoredProvider<WeeklySubscriptionUsageStatus>({
        piProviderId: "anthropic",
        makeLayer: (publish) => {
          options.onMakeClaudeLayer?.();
          return claudeProviderMonitorLayer({
            resolveCredentialIdentity: Effect.succeed({
              kind: "available",
              fingerprint: "claude-1",
            }),
            acquireClaudeSubscriptionUsage: () =>
              options.acquireClaude ?? Effect.succeed(claudeUsage),
            publish,
            random: Effect.succeed(0.5),
          });
        },
        present: (status, nowMs) =>
          presentProviderSubscriptionUsage("Claude", status, nowMs),
      }),
    ],
  };
}

test("shutdown interrupts active session work", async () => {
  const session = await Effect.runPromise(
    makeMonitoredProviderCapacitySession(),
  );
  let finalized = 0;
  const presentations: CapacityRecord[] = [];
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
  const session = await Effect.runPromise(
    makeMonitoredProviderCapacitySession(),
  );
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
    session.observeResponse("openai-codex", {
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
  const session = await Effect.runPromise(
    makeMonitoredProviderCapacitySession(),
  );
  let releaseCredential!: () => void;
  const credentialGate = new Promise<void>((resolve) => {
    releaseCredential = resolve;
  });
  let acquisitions = 0;
  const presentations: unknown[] = [];
  const start = Effect.runPromise(
    session.start(
      sessionDependencies({
        present: (statuses) => presentations.push(statuses),
        resolveCodex: Effect.promise(() => credentialGate).pipe(
          Effect.as({
            kind: "available" as const,
            credential: {
              accessToken: "codex-token",
              accountId: "codex-1",
            },
          }),
        ),
        acquireCodex: () => {
          acquisitions += 1;
          return Effect.succeed(codexUsage);
        },
      }),
    ),
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
  const session = await Effect.runPromise(
    makeMonitoredProviderCapacitySession(),
  );
  let codexReads = 0;
  let acquisition: Effect.Effect<
    AcquiredWeeklyQuotaUsage,
    TemporaryAcquisitionFailure
  > = Effect.succeed({ ...codexUsage, resetsAtMs: Date.now() + 100 });
  const presentations: unknown[] = [];
  await Effect.runPromise(
    session.start(
      sessionDependencies({
        present: (statuses) => presentations.push(statuses),
        acquireCodex: () => {
          codexReads += 1;
          return acquisition;
        },
      }),
    ),
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
  const session = await Effect.runPromise(
    makeMonitoredProviderCapacitySession(),
  );
  let finalized = 0;
  let releasePrevious!: () => void;
  const previousGate = new Promise<void>((resolve) => {
    releasePrevious = resolve;
  });
  const countFinalization = Effect.sync(() => {
    finalized += 1;
  });
  const presentations: CapacityRecord[] = [];
  const previousStart = Effect.runPromise(
    session.start(
      sessionDependencies({
        acquireCodex: () =>
          Effect.uninterruptible(Effect.promise(() => previousGate)).pipe(
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
  const session = await Effect.runPromise(
    makeMonitoredProviderCapacitySession(),
  );
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const presentations: CapacityRecord[] = [];
  const first = Effect.runPromise(
    session.start(
      sessionDependencies({
        acquireCodex: () =>
          Effect.uninterruptible(Effect.promise(() => firstGate)).pipe(
            Effect.as({ ...codexUsage, usedPercent: 99 }),
          ),
        acquireClaude: Effect.uninterruptible(
          Effect.promise(() => firstGate),
        ).pipe(Effect.as({ ...claudeUsage, usedPercent: 99 })),
        present: (statuses) => presentations.push(statuses),
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  let middleClaudeLayerCreated = 0;
  let middleCodexReads = 0;
  const middle = Effect.runPromise(
    session.start(
      sessionDependencies({
        present: (statuses) => presentations.push(statuses),
        acquireCodex: () => {
          middleCodexReads += 1;
          return Effect.succeed({ ...codexUsage, usedPercent: 50 });
        },
        onMakeClaudeLayer: () => {
          middleClaudeLayerCreated += 1;
        },
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const latest = Effect.runPromise(
    session.start(
      sessionDependencies({
        acquireCodex: () => Effect.succeed({ ...codexUsage, usedPercent: 30 }),
        acquireClaude: Effect.succeed({ ...claudeUsage, usedPercent: 40 }),
        present: (statuses) => presentations.push(statuses),
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([first, middle, latest]);

  assert.equal(middleClaudeLayerCreated, 0);
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

test("accepts non-weekly capacity through the provider roster", async () => {
  const session = await Effect.runPromise(
    makeMonitoredProviderCapacitySession(),
  );
  const presentations: unknown[] = [];

  await Effect.runPromise(
    session.start({
      now: Effect.succeed(1_000_000),
      providers: [
        defineMonitoredProvider<OpenRouterKeyCapacityStatus>({
          piProviderId: "openrouter",
          makeLayer: (publish) =>
            Layer.succeed(ProviderMonitorService, {
              start: publish({ kind: "openrouter-key-no-limit" }).pipe(
                Effect.andThen(
                  publish({
                    kind: "openrouter-key-remaining-spend",
                    remainingUsd: 12.34,
                    stale: false,
                  }),
                ),
              ),
              observeResponse: () => Effect.void,
              refreshAfterActivity: Effect.void,
              refreshForAccountChange: Effect.void,
            }),
          present: (status) => ({
            providerName: "OpenRouter",
            detail:
              status.kind === "openrouter-key-no-limit"
                ? "no limit"
                : status.kind === "openrouter-key-remaining-spend"
                  ? `$${status.remainingUsd}`
                  : "unexpected",
            color: "dim",
          }),
        }),
      ],
      present: (capacities) =>
        Effect.sync(() => presentations.push(structuredClone(capacities))),
    }),
  );

  assert.deepEqual(presentations, [
    [
      {
        status: { kind: "openrouter-key-no-limit" },
        presentation: {
          providerName: "OpenRouter",
          detail: "no limit",
          color: "dim",
        },
      },
    ],
    [
      {
        status: {
          kind: "openrouter-key-remaining-spend",
          remainingUsd: 12.34,
          stale: false,
        },
        presentation: {
          providerName: "OpenRouter",
          detail: "$12.34",
          color: "dim",
        },
      },
    ],
  ]);
  await Effect.runPromise(session.shutdown);
});

test("starts from a one-provider roster without fixed provider knowledge", async () => {
  const session = await Effect.runPromise(
    makeMonitoredProviderCapacitySession(),
  );
  const dependencies = sessionDependencies();
  const claudeProvider = dependencies.providers[1];
  assert.ok(claudeProvider);
  const presentations: unknown[] = [];

  await Effect.runPromise(
    session.start({
      ...dependencies,
      providers: [claudeProvider],
      present: (capacities) =>
        Effect.sync(() => presentations.push(structuredClone(capacities))),
    }),
  );

  assert.deepEqual(presentations.at(-1), [
    {
      status: {
        kind: "available",
        usedPercent: 80,
        stale: false,
        weeklyWindowResetsAtMs: 2_000_000,
      },
      presentation: {
        providerName: "Claude",
        detail: "wk ━━━━━━━━── 80% 16m",
        color: "warning",
      },
    },
  ]);
  await Effect.runPromise(session.shutdown);
});

test("routes activity and responses through the provider roster", async () => {
  const session = await Effect.runPromise(
    makeMonitoredProviderCapacitySession(),
  );
  let codexReads = 0;
  let claudeReads = 0;
  let claudeAcquisition: Effect.Effect<
    AcquiredClaudeSubscriptionUsage,
    ClaudeSubscriptionUsageAcquisitionError
  > = Effect.fail(new ClaudeAuthenticationUnavailable());
  const presentations: CapacityRecord[] = [];
  await Effect.runPromise(
    session.start(
      sessionDependencies({
        acquireCodex: () => {
          codexReads += 1;
          return Effect.succeed(codexUsage);
        },
        acquireClaude: Effect.suspend(() => {
          claudeReads += 1;
          return claudeAcquisition;
        }),
        present: (statuses) => presentations.push(statuses),
      }),
    ),
  );

  claudeAcquisition = Effect.succeed(claudeUsage);
  await Effect.runPromise(session.refreshAfterActivity("anthropic"));
  assert.deepEqual([codexReads, claudeReads], [1, 2]);
  assert.equal(presentations.at(-1)?.Claude.kind, "available");

  await Effect.runPromise(
    session.observeResponse("openai-codex", {
      "x-codex-primary-used-percent": "70",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": "2000",
    }),
  );
  assert.deepEqual(presentations.at(-1)?.Codex, {
    kind: "available",
    usedPercent: 70,
    stale: false,
    weeklyWindowResetsAtMs: 2_000_000,
  });

  await Effect.runPromise(session.refreshAfterActivity("unknown"));
  assert.deepEqual([codexReads, claudeReads], [1, 2]);

  await Effect.runPromise(session.shutdown);
});
