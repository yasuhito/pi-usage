import assert from "node:assert/strict";
import test from "node:test";

import type { WeeklyQuotaUsage } from "../src/codex-usage.ts";
import { createPassiveWeeklyQuotaObserver } from "../src/passive-weekly-quota-observation.ts";

const baseline: WeeklyQuotaUsage = {
  usedPercent: 63,
  resetsAtMs: 4_000_000,
  windowPosition: "secondary",
};

test("observes a seven-day window from mixed-case fields", () => {
  const observer = createPassiveWeeklyQuotaObserver();

  assert.deepEqual(
    observer.observe({
      "X-Codex-Secondary-Used-Percent": "72.5",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "4000",
    }),
    {
      kind: "observed",
      usage: {
        usedPercent: 72.5,
        resetsAtMs: 4_000_000,
        windowPosition: "secondary",
      },
    },
  );
});

test("accumulates sparse fields across provider responses", () => {
  const observer = createPassiveWeeklyQuotaObserver();

  assert.deepEqual(
    observer.observe({
      "x-codex-secondary-window-minutes": "10080",
    }),
    { kind: "incomplete" },
  );
  assert.deepEqual(
    observer.observe({
      "x-codex-secondary-used-percent": "74",
      "x-codex-secondary-reset-at": "4000",
    }),
    {
      kind: "observed",
      usage: {
        usedPercent: 74,
        resetsAtMs: 4_000_000,
        windowPosition: "secondary",
      },
    },
  );
});

test("completes sparse fields from a same-position baseline", () => {
  const observer = createPassiveWeeklyQuotaObserver();
  observer.setBaseline(baseline);

  assert.deepEqual(
    observer.observe({ "x-codex-secondary-used-percent": "74" }),
    {
      kind: "observed",
      usage: { ...baseline, usedPercent: 74 },
    },
  );
});

test("an unrelated response neither contributes nor replays fields", () => {
  const observer = createPassiveWeeklyQuotaObserver();
  observer.observe({
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-used-percent": "74",
  });

  assert.deepEqual(observer.observe({ other: "value" }), {
    kind: "unrecognized",
  });
  assert.equal(
    observer.observe({ "x-codex-secondary-reset-at": "4000" }).kind,
    "observed",
  );
});

test("a recognized non-string field is malformed", () => {
  const observer = createPassiveWeeklyQuotaObserver();

  assert.deepEqual(observer.observe({ "x-codex-secondary-used-percent": 74 }), {
    kind: "malformed",
  });
});

test("malformed fields reset accumulated fields and the baseline", () => {
  const observer = createPassiveWeeklyQuotaObserver();
  observer.setBaseline(baseline);

  assert.deepEqual(
    observer.observe({ "x-codex-secondary-used-percent": " " }),
    { kind: "malformed" },
  );
  assert.deepEqual(
    observer.observe({ "x-codex-secondary-used-percent": "74" }),
    { kind: "incomplete" },
  );
});

test("primary wins when both positions contain weekly observations", () => {
  const observer = createPassiveWeeklyQuotaObserver();

  const result = observer.observe({
    "x-codex-primary-used-percent": "25",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-reset-at": "3000",
    "x-codex-secondary-used-percent": "75",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "4000",
  });

  assert.equal(result.kind, "observed");
  if (result.kind === "observed") {
    assert.equal(result.usage.windowPosition, "primary");
  }
});

test("skips a complete non-weekly position", () => {
  const observer = createPassiveWeeklyQuotaObserver();

  const result = observer.observe({
    "x-codex-primary-used-percent": "25",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "3000",
    "x-codex-secondary-used-percent": "75",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "4000",
  });

  assert.equal(result.kind, "observed");
  if (result.kind === "observed") {
    assert.equal(result.usage.windowPosition, "secondary");
  }
});

test("clearing the baseline preserves accumulated fields", () => {
  const observer = createPassiveWeeklyQuotaObserver();
  observer.observe({
    "x-codex-secondary-window-minutes": "10080",
  });

  observer.setBaseline(undefined);

  assert.equal(
    observer.observe({
      "x-codex-secondary-used-percent": "74",
      "x-codex-secondary-reset-at": "4000",
    }).kind,
    "observed",
  );
});

test("reset discards accumulated fields and the baseline", () => {
  const observer = createPassiveWeeklyQuotaObserver();
  observer.setBaseline(baseline);
  observer.observe({
    "x-codex-primary-window-minutes": "10080",
  });

  observer.reset();

  assert.deepEqual(
    observer.observe({
      "x-codex-primary-used-percent": "74",
      "x-codex-primary-reset-at": "4000",
    }),
    { kind: "incomplete" },
  );
});
