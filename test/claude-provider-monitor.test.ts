import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, TestClock } from "effect";

import { makeClaudeProviderMonitor } from "../src/claude-provider-monitor.ts";
import {
  type AcquiredClaudeSubscriptionUsage,
  PermanentClaudeSubscriptionUsageFailure,
  TemporaryClaudeSubscriptionUsageFailure,
} from "../src/claude-subscription-usage-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "../src/presentation.ts";

function fixture() {
  return Effect.gen(function* () {
    let acquisition: Effect.Effect<
      AcquiredClaudeSubscriptionUsage,
      | TemporaryClaudeSubscriptionUsageFailure
      | PermanentClaudeSubscriptionUsageFailure
    > = Effect.succeed({ usedPercent: 63.4, resetsAtMs: 2_000_000 });
    const statuses: WeeklySubscriptionUsageStatus[] = [];
    const monitor = yield* makeClaudeProviderMonitor({
      acquireClaudeSubscriptionUsage: () => acquisition,
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
      random: Effect.succeed(0.5),
    });
    return {
      monitor,
      statuses,
      setAcquisition: (value: typeof acquisition) => {
        acquisition = value;
      },
    };
  });
}

it.scoped("publishes Claude weekly subscription usage", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    assert.deepEqual(f.statuses, [
      { kind: "loading" },
      {
        kind: "available",
        usedPercent: 63.4,
        stale: false,
        weeklyWindowResetsAtMs: 2_000_000,
      },
    ]);
  }),
);

it.scoped("keeps temporary failures stale for at most ten minutes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    f.setAcquisition(
      Effect.fail(new TemporaryClaudeSubscriptionUsageFailure()),
    );
    yield* f.monitor.refreshForAccountChange;
    const stale = f.statuses.at(-1);
    assert.equal(stale?.kind === "available" && stale.stale, true);
    yield* TestClock.adjust("10 minutes");
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
  }),
);

it.scoped("turns terminal acquisition failures into unavailable", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setAcquisition(
      Effect.fail(new PermanentClaudeSubscriptionUsageFailure()),
    );
    yield* f.monitor.start;
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
  }),
);
