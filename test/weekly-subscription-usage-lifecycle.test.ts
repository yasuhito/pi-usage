import assert from "node:assert/strict";
import { test } from "vitest";

import { createWeeklySubscriptionUsageLifecycle } from "../src/weekly-subscription-usage-lifecycle.ts";

interface Usage {
  readonly usedPercent: number;
  readonly resetsAtMs: number;
}

test("retains temporarily unavailable usage until its provider deadline", () => {
  const lifecycle = createWeeklySubscriptionUsageLifecycle<Usage>({
    staleRetentionMs: 10 * 60_000,
  });

  assert.deepEqual(
    lifecycle.advance({
      kind: "observed",
      usage: { usedPercent: 63, resetsAtMs: 2_000_000 },
      observedAtMs: 1_000,
    }),
    {
      observation: {
        kind: "usage",
        usage: { usedPercent: 63, resetsAtMs: 2_000_000 },
        freshness: "fresh",
      },
      publication: "replace",
      staleExpirationAtMs: undefined,
    },
  );

  assert.deepEqual(
    lifecycle.advance({ kind: "temporarily-unavailable", nowMs: 2_000 }),
    {
      observation: {
        kind: "usage",
        usage: { usedPercent: 63, resetsAtMs: 2_000_000 },
        freshness: "stale",
      },
      publication: "replace",
      staleExpirationAtMs: 601_000,
    },
  );
});

test("never retains stale usage beyond its reported reset", () => {
  const lifecycle = createWeeklySubscriptionUsageLifecycle<Usage>({
    staleRetentionMs: 10 * 60_000,
  });
  lifecycle.advance({
    kind: "observed",
    usage: { usedPercent: 63, resetsAtMs: 500_000 },
    observedAtMs: 1_000,
  });

  const stale = lifecycle.advance({
    kind: "temporarily-unavailable",
    nowMs: 2_000,
  });

  assert.equal(stale.staleExpirationAtMs, 500_000);
});

test("rejects an old expiration after a newer observation", () => {
  const lifecycle = createWeeklySubscriptionUsageLifecycle<Usage>({});
  lifecycle.advance({
    kind: "observed",
    usage: { usedPercent: 40, resetsAtMs: 10_000 },
    observedAtMs: 1_000,
  });
  lifecycle.advance({ kind: "temporarily-unavailable", nowMs: 2_000 });
  lifecycle.advance({
    kind: "observed",
    usage: { usedPercent: 41, resetsAtMs: 20_000 },
    observedAtMs: 3_000,
  });

  assert.deepEqual(
    lifecycle.advance({
      kind: "stale-expiration-reached",
      deadlineMs: 10_000,
      nowMs: 10_000,
    }),
    {
      observation: {
        kind: "usage",
        usage: { usedPercent: 41, resetsAtMs: 20_000 },
        freshness: "fresh",
      },
      publication: "preserve",
      staleExpirationAtMs: undefined,
    },
  );
});

test("invalidation publishes removal while session end only discards state", () => {
  const lifecycle = createWeeklySubscriptionUsageLifecycle<Usage>({});
  lifecycle.advance({
    kind: "observed",
    usage: { usedPercent: 80, resetsAtMs: 10_000 },
    observedAtMs: 1_000,
  });

  assert.deepEqual(lifecycle.advance({ kind: "invalidated" }), {
    observation: { kind: "none" },
    publication: "replace",
    staleExpirationAtMs: undefined,
  });
  lifecycle.advance({
    kind: "observed",
    usage: { usedPercent: 81, resetsAtMs: 10_000 },
    observedAtMs: 2_000,
  });
  assert.deepEqual(lifecycle.advance({ kind: "session-ended" }), {
    observation: { kind: "none" },
    publication: "preserve",
    staleExpirationAtMs: undefined,
  });
});

test("expires stale usage at its reported reset", () => {
  const lifecycle = createWeeklySubscriptionUsageLifecycle<Usage>({});
  lifecycle.advance({
    kind: "observed",
    usage: { usedPercent: 80, resetsAtMs: 10_000 },
    observedAtMs: 1_000,
  });
  lifecycle.advance({ kind: "temporarily-unavailable", nowMs: 2_000 });

  assert.deepEqual(
    lifecycle.advance({
      kind: "stale-expiration-reached",
      deadlineMs: 10_000,
      nowMs: 10_000,
    }),
    {
      observation: { kind: "none" },
      publication: "replace",
      staleExpirationAtMs: undefined,
    },
  );
});
