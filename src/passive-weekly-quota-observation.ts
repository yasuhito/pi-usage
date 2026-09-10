import type {
  RateLimitWindowPosition,
  WeeklyQuotaUsage,
} from "./codex-usage.ts";
import {
  CODEX_WEEK_SECONDS,
  parseFiniteNumber,
  weeklyQuotaUsageFromProviderValues,
} from "./codex-weekly-quota-values.ts";

const WEEK_MINUTES = CODEX_WEEK_SECONDS / 60;
const WINDOW_POSITIONS = ["primary", "secondary"] as const;
const RATE_LIMIT_FIELD_NAMES = new Set(
  WINDOW_POSITIONS.flatMap((position) => [
    `x-codex-${position}-used-percent`,
    `x-codex-${position}-window-minutes`,
    `x-codex-${position}-reset-at`,
  ]),
);

export type PassiveWeeklyQuotaObservationResult =
  | { readonly kind: "unrecognized" }
  | { readonly kind: "incomplete" }
  | { readonly kind: "observed"; readonly usage: WeeklyQuotaUsage }
  | { readonly kind: "malformed" };

export interface PassiveWeeklyQuotaObserver {
  readonly observe: (
    fields: Readonly<Record<string, unknown>>,
  ) => PassiveWeeklyQuotaObservationResult;
  readonly setBaseline: (usage: WeeklyQuotaUsage | undefined) => void;
  readonly reset: () => void;
}

function usageForPosition(
  fields: Readonly<Record<string, string>>,
  baseline: WeeklyQuotaUsage | undefined,
  position: RateLimitWindowPosition,
): WeeklyQuotaUsage | undefined | "malformed" {
  const prefix = `x-codex-${position}`;
  const rawDuration = fields[`${prefix}-window-minutes`];
  const rawUsedPercent = fields[`${prefix}-used-percent`];
  const rawResetsAt = fields[`${prefix}-reset-at`];
  if (
    rawDuration === undefined &&
    rawUsedPercent === undefined &&
    rawResetsAt === undefined
  ) {
    return undefined;
  }

  const prior = baseline?.windowPosition === position ? baseline : undefined;
  const durationMinutes =
    rawDuration === undefined
      ? prior === undefined
        ? undefined
        : WEEK_MINUTES
      : parseFiniteNumber(rawDuration);
  const usedPercent =
    rawUsedPercent === undefined
      ? prior?.usedPercent
      : parseFiniteNumber(rawUsedPercent);
  const resetsAtSeconds =
    rawResetsAt === undefined
      ? prior === undefined
        ? undefined
        : prior.resetsAtMs / 1_000
      : parseFiniteNumber(rawResetsAt);

  if (
    (rawDuration !== undefined && durationMinutes === undefined) ||
    (rawUsedPercent !== undefined && usedPercent === undefined) ||
    (rawResetsAt !== undefined && resetsAtSeconds === undefined)
  ) {
    return "malformed";
  }
  if (
    durationMinutes === undefined ||
    usedPercent === undefined ||
    resetsAtSeconds === undefined
  ) {
    return undefined;
  }
  const result = weeklyQuotaUsageFromProviderValues(
    position,
    durationMinutes * 60,
    usedPercent,
    resetsAtSeconds,
  );
  if (result.kind === "malformed") return "malformed";
  return result.kind === "observed" ? result.usage : undefined;
}

export function createPassiveWeeklyQuotaObserver(): PassiveWeeklyQuotaObserver {
  let accumulatedFields: Record<string, string> = {};
  let baseline: WeeklyQuotaUsage | undefined;

  const reset = (): void => {
    accumulatedFields = {};
    baseline = undefined;
  };

  return {
    observe: (fields) => {
      let contributed = false;
      for (const [name, value] of Object.entries(fields)) {
        const normalizedName = name.toLowerCase();
        if (!RATE_LIMIT_FIELD_NAMES.has(normalizedName)) continue;
        if (typeof value !== "string") {
          reset();
          return { kind: "malformed" };
        }
        accumulatedFields[normalizedName] = value;
        contributed = true;
      }
      if (!contributed) return { kind: "unrecognized" };

      for (const position of WINDOW_POSITIONS) {
        const usage = usageForPosition(accumulatedFields, baseline, position);
        if (usage === "malformed") {
          reset();
          return { kind: "malformed" };
        }
        if (usage !== undefined) {
          accumulatedFields = {};
          baseline = usage;
          return { kind: "observed", usage };
        }
      }
      return { kind: "incomplete" };
    },
    setBaseline: (usage) => {
      baseline = usage;
      if (usage !== undefined) accumulatedFields = {};
    },
    reset,
  };
}
