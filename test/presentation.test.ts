import assert from "node:assert/strict";
import { test } from "vitest";

import {
  presentCodexQuotaStatus,
  presentProviderSubscriptionUsage,
} from "../src/presentation.ts";

test("fresh weekly quota usage is presented as a ten-cell used bar", () => {
  assert.deepEqual(
    presentCodexQuotaStatus(
      {
        kind: "available",
        usedPercent: 63,
        stale: false,
        weeklyWindowResetsAtMs: Date.UTC(2026, 8, 14, 14),
        availableLimitResetCredits: 2,
      },
      Date.UTC(2026, 8, 11, 12),
    ),
    {
      text: "Codex wk ━━━━━━──── 63% · reset 3d 2h · ↻2",
      color: "dim",
    },
  );
});

test("quota presentation rounds, clamps, colors, and marks freshness", () => {
  const cases = [
    {
      status: { kind: "available", usedPercent: -2, stale: false } as const,
      expected: { text: "Codex wk ────────── 0%", color: "dim" },
    },
    {
      status: { kind: "available", usedPercent: 66, stale: false } as const,
      expected: { text: "Codex wk ━━━━━━━─── 66%", color: "dim" },
    },
    {
      status: { kind: "available", usedPercent: 75, stale: true } as const,
      expected: { text: "Codex wk ━━━━━━━━── 75% ~", color: "warning" },
    },
    {
      status: { kind: "available", usedPercent: 90, stale: false } as const,
      expected: { text: "Codex wk ━━━━━━━━━─ 90%", color: "error" },
    },
    {
      status: { kind: "available", usedPercent: 101, stale: false } as const,
      expected: { text: "Codex wk ━━━━━━━━━━ 100%", color: "error" },
    },
  ];

  for (const { status, expected } of cases) {
    assert.deepEqual(presentCodexQuotaStatus(status), expected);
  }
});

test("weekly reset countdown uses compact hour, minute, and elapsed forms", () => {
  const nowMs = Date.UTC(2026, 8, 11, 12);
  const status = {
    kind: "available" as const,
    usedPercent: 20,
    stale: false,
  };

  const cases = [
    [23 * 60 * 60_000 + 59 * 60_000 + 30_000, "23h 59m"],
    [2 * 60 * 60_000 + 30 * 60_000, "2h 30m"],
    [59 * 60_000 + 30_000, "59m"],
    [42 * 60_000, "42m"],
    [0, "now"],
  ] as const;

  for (const [remainingMs, expected] of cases) {
    assert.equal(
      presentCodexQuotaStatus(
        { ...status, weeklyWindowResetsAtMs: nowMs + remainingMs },
        nowMs,
      ).text,
      `Codex wk ━━──────── 20% · reset ${expected}`,
    );
  }
});

test("zero limit reset credits are shown while an unavailable count is omitted", () => {
  assert.equal(
    presentCodexQuotaStatus({
      kind: "available",
      usedPercent: 20,
      stale: false,
      availableLimitResetCredits: 0,
    }).text,
    "Codex wk ━━──────── 20% · ↻0",
  );
  assert.equal(
    presentCodexQuotaStatus({
      kind: "available",
      usedPercent: 20,
      stale: false,
    }).text,
    "Codex wk ━━──────── 20%",
  );
});

test("Claude retains its weekly label and shares Codex thresholds", () => {
  assert.deepEqual(
    presentProviderSubscriptionUsage("Claude", {
      kind: "available",
      usedPercent: 90,
      stale: true,
    }),
    {
      providerName: "Claude",
      detail: "wk ━━━━━━━━━─ 90% ~",
      color: "error",
    },
  );
  assert.deepEqual(
    presentProviderSubscriptionUsage("Claude", {
      kind: "unavailable",
    }),
    {
      providerName: "Claude",
      detail: "wk unavailable",
      color: "dim",
    },
  );
});

test("loading and unavailable statuses have compact neutral presentations", () => {
  assert.deepEqual(presentCodexQuotaStatus({ kind: "loading" }), {
    text: "Codex wk loading…",
    color: "dim",
  });
  assert.deepEqual(presentCodexQuotaStatus({ kind: "unavailable" }), {
    text: "Codex wk unavailable",
    color: "dim",
  });
});
