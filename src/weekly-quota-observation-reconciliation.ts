import type {
  DedicatedWeeklyQuotaAcquisitionResult,
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

export type WeeklyQuotaObservationDiscardReason =
  | "account-change"
  | "missing-credential"
  | "invalid-credential"
  | "stale-usage-expired"
  | "session-end";

export interface WeeklyQuotaObservationReconciliation {
  /**
   * Accumulates recognized sparse fields in call order. An observed result
   * becomes the baseline and clears accumulated fields; malformed recognized
   * fields discard both.
   */
  readonly observePassive: (
    fields: Readonly<Record<string, unknown>>,
  ) => PassiveWeeklyQuotaObservationResult;
  /**
   * Reconciles the final acquisition result after any authentication retry.
   * Temporary failure preserves all state. Permanent unavailability and final
   * authentication rejection clear only the baseline. An observed result
   * replaces the baseline and accumulated fields; malformed data discards both.
   */
  readonly reconcileDedicated: (
    result: DedicatedWeeklyQuotaAcquisitionResult,
  ) => DedicatedWeeklyQuotaAcquisitionResult;
  /**
   * Stale usage expiration clears only the baseline. Every other reason
   * discards the baseline and accumulated fields.
   */
  readonly discard: (reason: WeeklyQuotaObservationDiscardReason) => void;
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

export function createWeeklyQuotaObservationReconciliation(): WeeklyQuotaObservationReconciliation {
  let accumulatedFields: Record<string, string> = {};
  let baseline: WeeklyQuotaUsage | undefined;

  const discardAll = (): void => {
    accumulatedFields = {};
    baseline = undefined;
  };

  return {
    observePassive: (fields) => {
      let contributed = false;
      for (const [name, value] of Object.entries(fields)) {
        const normalizedName = name.toLowerCase();
        if (!RATE_LIMIT_FIELD_NAMES.has(normalizedName)) continue;
        if (typeof value !== "string") {
          discardAll();
          return { kind: "malformed" };
        }
        accumulatedFields[normalizedName] = value;
        contributed = true;
      }
      if (!contributed) return { kind: "unrecognized" };

      for (const position of WINDOW_POSITIONS) {
        const usage = usageForPosition(accumulatedFields, baseline, position);
        if (usage === "malformed") {
          discardAll();
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
    reconcileDedicated: (result) => {
      if (result.kind === "observed") {
        accumulatedFields = {};
        baseline = result.usage;
      } else if (result.kind === "malformed-observation") {
        discardAll();
      } else if (
        result.kind === "authentication-rejected" ||
        result.kind === "permanently-unavailable"
      ) {
        baseline = undefined;
      }
      return result;
    },
    discard: (reason) => {
      if (reason === "stale-usage-expired") {
        baseline = undefined;
        return;
      }
      discardAll();
    },
  };
}
