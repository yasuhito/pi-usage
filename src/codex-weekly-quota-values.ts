import type {
  RateLimitWindowPosition,
  WeeklyQuotaUsage,
} from "./codex-usage.ts";

export const CODEX_WEEK_SECONDS = 7 * 24 * 60 * 60;

export type CodexWeeklyQuotaUsageResult =
  | { readonly kind: "not-weekly" }
  | { readonly kind: "malformed" }
  | { readonly kind: "observed"; readonly usage: WeeklyQuotaUsage };

export function parseFiniteNumber(
  value: string | undefined,
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function weeklyQuotaUsageFromProviderValues(
  position: RateLimitWindowPosition,
  durationSeconds: unknown,
  usedPercent: unknown,
  resetsAtSeconds: unknown,
): CodexWeeklyQuotaUsageResult {
  if (durationSeconds !== CODEX_WEEK_SECONDS) return { kind: "not-weekly" };
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    typeof resetsAtSeconds !== "number" ||
    !Number.isFinite(resetsAtSeconds) ||
    resetsAtSeconds <= 0
  ) {
    return { kind: "malformed" };
  }
  return {
    kind: "observed",
    usage: {
      usedPercent,
      resetsAtMs: resetsAtSeconds * 1_000,
      windowPosition: position,
    },
  };
}
