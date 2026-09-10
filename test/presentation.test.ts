import assert from "node:assert/strict";
import test from "node:test";

import { presentQuotaStatus } from "../src/presentation.ts";

test("fresh weekly quota usage is presented as a ten-cell used bar", () => {
  assert.deepEqual(
    presentQuotaStatus({
      kind: "available",
      usedPercent: 63,
      stale: false,
    }),
    {
      text: "Codex wk ━━━━━━──── 63%",
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
    assert.deepEqual(presentQuotaStatus(status), expected);
  }
});

test("loading and unavailable statuses have compact neutral presentations", () => {
  assert.deepEqual(presentQuotaStatus({ kind: "loading" }), {
    text: "Codex wk loading…",
    color: "dim",
  });
  assert.deepEqual(presentQuotaStatus({ kind: "unavailable" }), {
    text: "Codex wk unavailable",
    color: "dim",
  });
});
