import assert from "node:assert/strict";
import test from "node:test";

import type { AcquiredWeeklyQuotaUsage } from "../src/dedicated-weekly-quota-acquisition.ts";
import { createWeeklyQuotaObservationReconciliation } from "../src/weekly-quota-observation-reconciliation.ts";

const NOW = 1_000_000;

function observeDedicated(
  reconciliation: ReturnType<typeof createWeeklyQuotaObservationReconciliation>,
  nowMs = NOW,
  usage: AcquiredWeeklyQuotaUsage = {
    usedPercent: 63,
    resetsAtMs: 4_000_000,
    windowPosition: "secondary",
  },
) {
  return reconciliation.advance(
    {
      kind: "dedicated-weekly-quota-acquisition",
      result: { kind: "acquired", usage },
    },
    nowMs,
  );
}

function observePassive(
  reconciliation: ReturnType<typeof createWeeklyQuotaObservationReconciliation>,
  fields: Readonly<Record<string, unknown>>,
  nowMs = NOW,
) {
  return reconciliation.advance(
    { kind: "passive-weekly-quota-observation", fields },
    nowMs,
  );
}

function usageState(
  usedPercent: number,
  freshness: "fresh" | "stale" = "fresh",
  windowPosition: "primary" | "secondary" = "secondary",
) {
  return {
    kind: "usage" as const,
    usage: {
      usedPercent,
      resetsAtMs: 4_000_000,
      windowPosition,
    },
    freshness,
  };
}

test("records weekly quota usage from dedicated acquisition", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();

  const reaction = observeDedicated(reconciliation);

  assert.deepEqual(reaction, {
    observation: usageState(63),
    publication: "replace",
    staleExpirationAtMs: undefined,
    acquireDedicated: false,
  });
});

test("preserves dedicated limit reset credits across passive observation", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  const dedicated = observeDedicated(reconciliation, NOW, {
    usedPercent: 63,
    resetsAtMs: 4_000_000,
    windowPosition: "secondary",
    availableLimitResetCredits: 2,
  });
  const passive = observePassive(reconciliation, {
    "x-codex-primary-used-percent": "64",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-reset-at": "4000",
  });

  assert.deepEqual(dedicated.observation, {
    ...usageState(63),
    usage: { ...usageState(63).usage, availableLimitResetCredits: 2 },
  });
  assert.deepEqual(passive.observation, {
    ...usageState(64, "fresh", "primary"),
    usage: {
      ...usageState(64, "fresh", "primary").usage,
      availableLimitResetCredits: 2,
    },
  });
});

test("malformed dedicated evidence clears all observation evidence", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  observePassive(reconciliation, {
    "x-codex-primary-window-minutes": "10080",
  });
  reconciliation.advance(
    {
      kind: "dedicated-weekly-quota-acquisition",
      result: { kind: "malformed-observation" },
    },
    NOW,
  );

  const reaction = observePassive(reconciliation, {
    "x-codex-primary-used-percent": "74",
    "x-codex-primary-reset-at": "4000",
  });

  assert.deepEqual(reaction.observation, { kind: "none" });
  assert.equal(reaction.publication, "preserve");
});

test("observes a weekly window from mixed-case passive evidence", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();

  const reaction = observePassive(reconciliation, {
    "X-Codex-Secondary-Used-Percent": "72.5",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "4000",
  });

  assert.deepEqual(reaction.observation, usageState(72.5));
  assert.equal(reaction.publication, "replace");
});

test("accumulates sparse passive evidence in call order", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();

  const incomplete = observePassive(reconciliation, {
    "x-codex-secondary-window-minutes": "10080",
  });
  const observed = observePassive(reconciliation, {
    "x-codex-secondary-used-percent": "74",
    "x-codex-secondary-reset-at": "4000",
  });

  assert.equal(incomplete.publication, "preserve");
  assert.deepEqual(observed.observation, usageState(74));
});

test("a dedicated observation becomes a same-position passive baseline", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  observeDedicated(reconciliation);

  const reaction = observePassive(reconciliation, {
    "x-codex-secondary-used-percent": "74",
  });

  assert.deepEqual(reaction.observation, usageState(74));
});

test("unrecognized passive evidence recommends acquisition only for old usage", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  observeDedicated(reconciliation);

  assert.equal(
    observePassive(reconciliation, { other: "value" }, NOW + 29_999)
      .acquireDedicated,
    false,
  );
  assert.equal(
    observePassive(reconciliation, { other: "value" }, NOW + 30_000)
      .acquireDedicated,
    true,
  );
});

test("activity uses observation age to recommend dedicated acquisition", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();

  assert.equal(
    reconciliation.advance({ kind: "activity" }, NOW).acquireDedicated,
    true,
  );
  observeDedicated(reconciliation);
  assert.equal(
    reconciliation.advance({ kind: "activity" }, NOW + 29_999).acquireDedicated,
    false,
  );
  assert.equal(
    reconciliation.advance({ kind: "activity" }, NOW + 30_000).acquireDedicated,
    true,
  );
});

test("treats inaccessible passive evidence as malformed", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  observeDedicated(reconciliation);
  const fields = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("inaccessible provider evidence");
      },
    },
  );

  const reaction = observePassive(reconciliation, fields);

  assert.deepEqual(reaction.observation, { kind: "none" });
  assert.equal(reaction.publication, "replace");
});

test("malformed passive evidence discards the baseline and sparse evidence", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  observeDedicated(reconciliation);
  observePassive(reconciliation, {
    "x-codex-primary-window-minutes": "10080",
  });

  const malformed = observePassive(reconciliation, {
    "x-codex-secondary-used-percent": " ",
  });
  const remainder = observePassive(reconciliation, {
    "x-codex-primary-used-percent": "74",
    "x-codex-primary-reset-at": "4000",
  });

  assert.deepEqual(malformed.observation, { kind: "none" });
  assert.equal(malformed.publication, "replace");
  assert.deepEqual(remainder.observation, { kind: "none" });
});

test("primary wins when both positions contain weekly observations", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();

  const reaction = observePassive(reconciliation, {
    "x-codex-primary-used-percent": "25",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-reset-at": "4000",
    "x-codex-secondary-used-percent": "75",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "4000",
  });

  assert.deepEqual(reaction.observation, usageState(25, "fresh", "primary"));
});

test("skips a complete non-weekly position", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();

  const reaction = observePassive(reconciliation, {
    "x-codex-primary-used-percent": "25",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "4000",
    "x-codex-secondary-used-percent": "75",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "4000",
  });

  assert.deepEqual(reaction.observation, usageState(75));
});

test("a dedicated observation replaces sparse passive evidence", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  observePassive(reconciliation, {
    "x-codex-primary-window-minutes": "10080",
  });
  observeDedicated(reconciliation);

  const reaction = observePassive(reconciliation, {
    "x-codex-primary-used-percent": "74",
    "x-codex-primary-reset-at": "4000",
  });

  assert.deepEqual(reaction.observation, usageState(63));
  assert.equal(reaction.publication, "preserve");
});

test("temporary acquisition failure publishes stale usage and its deadline", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  observeDedicated(reconciliation);

  const reaction = reconciliation.advance(
    {
      kind: "dedicated-weekly-quota-acquisition",
      result: { kind: "temporary-failure", retryAtMs: undefined },
    },
    NOW + 1,
  );

  assert.deepEqual(reaction.observation, usageState(63, "stale"));
  assert.equal(reaction.publication, "replace");
  assert.equal(reaction.staleExpirationAtMs, NOW + 600_000);
});

test("deferred acquisition also makes retained usage stale", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  observeDedicated(reconciliation);

  const reaction = reconciliation.advance(
    { kind: "dedicated-weekly-quota-acquisition-deferred" },
    NOW + 1,
  );

  assert.deepEqual(reaction.observation, usageState(63, "stale"));
});

test("stale usage expires while sparse passive evidence survives", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  observeDedicated(reconciliation);
  observePassive(reconciliation, {
    "x-codex-primary-window-minutes": "10080",
  });
  reconciliation.advance(
    {
      kind: "dedicated-weekly-quota-acquisition",
      result: { kind: "temporary-failure", retryAtMs: undefined },
    },
    NOW + 1,
  );

  const expired = reconciliation.advance(
    { kind: "stale-usage-expiration-reached" },
    NOW + 600_000,
  );
  const completed = observePassive(
    reconciliation,
    {
      "x-codex-primary-used-percent": "74",
      "x-codex-primary-reset-at": "4000",
    },
    NOW + 600_001,
  );

  assert.deepEqual(expired.observation, { kind: "none" });
  assert.equal(expired.publication, "replace");
  assert.deepEqual(completed.observation, usageState(74, "fresh", "primary"));
});

for (const result of [
  { kind: "authentication-rejected" } as const,
  { kind: "permanently-unavailable" } as const,
]) {
  test(`${result.kind} clears usage but preserves sparse evidence`, () => {
    const reconciliation = createWeeklyQuotaObservationReconciliation();
    observeDedicated(reconciliation);
    observePassive(reconciliation, {
      "x-codex-primary-window-minutes": "10080",
    });

    reconciliation.advance(
      { kind: "dedicated-weekly-quota-acquisition", result },
      NOW + 1,
    );
    const completed = observePassive(reconciliation, {
      "x-codex-primary-used-percent": "74",
      "x-codex-primary-reset-at": "4000",
    });

    assert.deepEqual(completed.observation, usageState(74, "fresh", "primary"));
  });
}

test("account selection invalidation discards usage and sparse evidence without publication", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  observeDedicated(reconciliation);
  observePassive(reconciliation, {
    "x-codex-primary-window-minutes": "10080",
  });

  const changed = reconciliation.advance(
    { kind: "account-selection-invalidated" },
    NOW + 1,
  );
  const remainder = observePassive(reconciliation, {
    "x-codex-primary-used-percent": "74",
    "x-codex-primary-reset-at": "4000",
  });

  assert.deepEqual(changed.observation, { kind: "none" });
  assert.equal(changed.publication, "preserve");
  assert.deepEqual(remainder.observation, { kind: "none" });
});

test("non-finite time throws before changing observation evidence", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  observeDedicated(reconciliation);

  assert.throws(
    () =>
      reconciliation.advance({ kind: "account-selection-invalidated" }, NaN),
    RangeError,
  );
  assert.deepEqual(
    reconciliation.advance({ kind: "activity" }, NOW).observation,
    usageState(63),
  );
});

test("clock rollback is evaluated without rejection", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  observeDedicated(reconciliation, NOW);

  assert.doesNotThrow(() =>
    reconciliation.advance({ kind: "activity" }, NOW - 1),
  );
});
