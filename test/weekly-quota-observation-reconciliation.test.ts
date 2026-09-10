import assert from "node:assert/strict";
import test from "node:test";

import type { WeeklyQuotaUsage } from "../src/codex-usage.ts";
import { createWeeklyQuotaObservationReconciliation } from "../src/weekly-quota-observation-reconciliation.ts";

const baseline: WeeklyQuotaUsage = {
  usedPercent: 63,
  resetsAtMs: 4_000_000,
  windowPosition: "secondary",
};

const observed = (usedPercent: number, windowPosition = "secondary") => ({
  kind: "observed" as const,
  usage: {
    usedPercent,
    resetsAtMs: 4_000_000,
    windowPosition: windowPosition as "primary" | "secondary",
  },
});

test("observes a seven-day window from mixed-case passive fields", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();

  assert.deepEqual(
    reconciliation.observePassive({
      "X-Codex-Secondary-Used-Percent": "72.5",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "4000",
    }),
    observed(72.5),
  );
});

test("accumulates sparse passive fields across provider responses", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();

  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-secondary-window-minutes": "10080",
    }),
    { kind: "incomplete" },
  );
  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-secondary-used-percent": "74",
      "x-codex-secondary-reset-at": "4000",
    }),
    observed(74),
  );
});

test("a dedicated observation becomes a same-position passive baseline", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  reconciliation.reconcileDedicated({ kind: "observed", usage: baseline });

  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-secondary-used-percent": "74",
    }),
    observed(74),
  );
});

test("an unrelated response neither contributes nor replays fields", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  reconciliation.observePassive({
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-used-percent": "74",
  });

  assert.deepEqual(reconciliation.observePassive({ other: "value" }), {
    kind: "unrecognized",
  });
  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-secondary-reset-at": "4000",
    }),
    observed(74),
  );
});

test("malformed passive fields discard the baseline and sparse fields", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  reconciliation.reconcileDedicated({ kind: "observed", usage: baseline });
  reconciliation.observePassive({
    "x-codex-primary-window-minutes": "10080",
  });

  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-secondary-used-percent": " ",
    }),
    { kind: "malformed" },
  );
  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-primary-used-percent": "74",
      "x-codex-primary-reset-at": "4000",
    }),
    { kind: "incomplete" },
  );
  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-secondary-used-percent": "74",
    }),
    { kind: "incomplete" },
  );
});

test("primary wins when both positions contain weekly observations", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();

  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-primary-used-percent": "25",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": "4000",
      "x-codex-secondary-used-percent": "75",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "4000",
    }),
    observed(25, "primary"),
  );
});

test("skips a complete non-weekly position", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();

  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-primary-used-percent": "25",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "4000",
      "x-codex-secondary-used-percent": "75",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "4000",
    }),
    observed(75),
  );
});

test("a dedicated observation replaces sparse fields", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  reconciliation.observePassive({
    "x-codex-primary-window-minutes": "10080",
  });

  reconciliation.reconcileDedicated({ kind: "observed", usage: baseline });

  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-primary-used-percent": "74",
      "x-codex-primary-reset-at": "4000",
    }),
    { kind: "incomplete" },
  );
});

test("temporary acquisition failure preserves the baseline and sparse fields", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  reconciliation.reconcileDedicated({ kind: "observed", usage: baseline });
  reconciliation.observePassive({
    "x-codex-primary-window-minutes": "10080",
  });

  reconciliation.reconcileDedicated({
    kind: "temporary-failure",
    retryAtMs: undefined,
  });

  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-primary-used-percent": "74",
      "x-codex-primary-reset-at": "4000",
    }),
    observed(74, "primary"),
  );
});

test("permanent acquisition failure clears the baseline but preserves sparse fields", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  reconciliation.reconcileDedicated({ kind: "observed", usage: baseline });
  reconciliation.observePassive({
    "x-codex-primary-window-minutes": "10080",
  });

  reconciliation.reconcileDedicated({ kind: "permanently-unavailable" });

  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-secondary-used-percent": "74",
    }),
    { kind: "incomplete" },
  );
  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-primary-used-percent": "74",
      "x-codex-primary-reset-at": "4000",
    }),
    observed(74, "primary"),
  );
});

test("a final authentication rejection clears the baseline but preserves sparse fields", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  reconciliation.reconcileDedicated({ kind: "observed", usage: baseline });
  reconciliation.observePassive({
    "x-codex-primary-window-minutes": "10080",
  });

  reconciliation.reconcileDedicated({ kind: "authentication-rejected" });

  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-primary-used-percent": "74",
      "x-codex-primary-reset-at": "4000",
    }),
    observed(74, "primary"),
  );
  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-secondary-used-percent": "74",
    }),
    { kind: "incomplete" },
  );
});

test("malformed dedicated observation discards the baseline and sparse fields", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  reconciliation.reconcileDedicated({ kind: "observed", usage: baseline });
  reconciliation.observePassive({
    "x-codex-primary-window-minutes": "10080",
  });

  reconciliation.reconcileDedicated({ kind: "malformed-observation" });

  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-primary-used-percent": "74",
      "x-codex-primary-reset-at": "4000",
    }),
    { kind: "incomplete" },
  );
  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-secondary-used-percent": "74",
    }),
    { kind: "incomplete" },
  );
});

for (const reason of [
  "account-change",
  "missing-credential",
  "invalid-credential",
  "session-end",
] as const) {
  test(`${reason} discards the baseline and sparse fields`, () => {
    const reconciliation = createWeeklyQuotaObservationReconciliation();
    reconciliation.reconcileDedicated({ kind: "observed", usage: baseline });
    reconciliation.observePassive({
      "x-codex-primary-window-minutes": "10080",
    });

    reconciliation.discard(reason);

    assert.deepEqual(
      reconciliation.observePassive({
        "x-codex-primary-used-percent": "74",
        "x-codex-primary-reset-at": "4000",
      }),
      { kind: "incomplete" },
    );
    assert.deepEqual(
      reconciliation.observePassive({
        "x-codex-secondary-used-percent": "74",
      }),
      { kind: "incomplete" },
    );
  });
}

test("stale usage expiration clears the baseline but preserves sparse fields", () => {
  const reconciliation = createWeeklyQuotaObservationReconciliation();
  reconciliation.reconcileDedicated({ kind: "observed", usage: baseline });
  reconciliation.observePassive({
    "x-codex-primary-window-minutes": "10080",
  });

  reconciliation.discard("stale-usage-expired");

  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-secondary-used-percent": "74",
    }),
    { kind: "incomplete" },
  );
  assert.deepEqual(
    reconciliation.observePassive({
      "x-codex-primary-used-percent": "74",
      "x-codex-primary-reset-at": "4000",
    }),
    observed(74, "primary"),
  );
});
