import type {
  AcquiredWeeklyQuotaUsage,
  DedicatedWeeklyQuotaAcquisitionResult,
} from "./dedicated-weekly-quota-acquisition.ts";

const PASSIVE_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const STALE_AFTER_MS = 10 * 60 * 1_000;
const REFRESH_DEBOUNCE_MS = 30_000;
const WINDOW_POSITIONS = ["primary", "secondary"] as const;

type RateLimitWindowPosition = AcquiredWeeklyQuotaUsage["windowPosition"];
export type WeeklyQuotaUsage = AcquiredWeeklyQuotaUsage;

const RATE_LIMIT_FIELD_NAMES = new Set(
  WINDOW_POSITIONS.flatMap((position) => [
    `x-codex-${position}-used-percent`,
    `x-codex-${position}-window-minutes`,
    `x-codex-${position}-reset-at`,
  ]),
);

export type WeeklyQuotaObservationEvent =
  | {
      readonly kind: "passive-weekly-quota-observation";
      readonly fields: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "dedicated-weekly-quota-acquisition";
      readonly result: DedicatedWeeklyQuotaAcquisitionResult;
    }
  | { readonly kind: "dedicated-weekly-quota-acquisition-deferred" }
  | { readonly kind: "activity" }
  | { readonly kind: "account-selection-invalidated" }
  | { readonly kind: "stale-usage-expiration-reached" };

export type WeeklyQuotaObservationState =
  | { readonly kind: "none" }
  | {
      readonly kind: "usage";
      readonly usage: WeeklyQuotaUsage;
      readonly freshness: "fresh" | "stale";
    };

export interface WeeklyQuotaObservationReaction {
  readonly observation: WeeklyQuotaObservationState;
  readonly publication: "preserve" | "replace";
  readonly staleExpirationAtMs: number | undefined;
  readonly acquireDedicated: boolean;
}

export interface WeeklyQuotaObservationReconciliation {
  /**
   * Applies events synchronously in call order. Time must be a finite epoch
   * millisecond value. Provider data failures are represented by the returned
   * reaction and never throw.
   */
  readonly advance: (
    event: WeeklyQuotaObservationEvent,
    nowMs: number,
  ) => WeeklyQuotaObservationReaction;
}

type UsageResult =
  | { readonly kind: "not-weekly" }
  | { readonly kind: "malformed" }
  | { readonly kind: "observed"; readonly usage: WeeklyQuotaUsage };

interface CapturedUsage {
  readonly usage: WeeklyQuotaUsage;
  readonly capturedAtMs: number;
  readonly freshness: "fresh" | "stale";
}

function parseFiniteNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function weeklyQuotaUsageFromProviderValues(
  position: RateLimitWindowPosition,
  durationSeconds: unknown,
  usedPercent: unknown,
  resetsAtSeconds: unknown,
): UsageResult {
  if (durationSeconds !== PASSIVE_WEEKLY_WINDOW_MINUTES * 60) {
    return { kind: "not-weekly" };
  }
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    typeof resetsAtSeconds !== "number" ||
    !Number.isFinite(resetsAtSeconds) ||
    resetsAtSeconds <= 0
  ) {
    return { kind: "malformed" };
  }
  const resetsAtMs = resetsAtSeconds * 1_000;
  if (!Number.isFinite(resetsAtMs)) return { kind: "malformed" };
  return {
    kind: "observed",
    usage: {
      usedPercent,
      resetsAtMs,
      windowPosition: position,
    },
  };
}

function entriesFromProviderFields(
  fields: Readonly<Record<string, unknown>>,
): Array<[string, unknown]> | undefined {
  try {
    return Object.entries(fields);
  } catch {
    return undefined;
  }
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
        : PASSIVE_WEEKLY_WINDOW_MINUTES
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
  if (result.kind !== "observed") return undefined;
  return baseline?.availableLimitResetCredits === undefined
    ? result.usage
    : {
        ...result.usage,
        availableLimitResetCredits: baseline.availableLimitResetCredits,
      };
}

export function createWeeklyQuotaObservationReconciliation(): WeeklyQuotaObservationReconciliation {
  let accumulatedFields: Record<string, string> = {};
  let capturedUsage: CapturedUsage | undefined;

  const discardAll = (): void => {
    accumulatedFields = {};
    capturedUsage = undefined;
  };
  const clearUsage = (): void => {
    capturedUsage = undefined;
  };
  const recordUsage = (usage: WeeklyQuotaUsage, capturedAtMs: number): void => {
    accumulatedFields = {};
    capturedUsage = { usage, capturedAtMs, freshness: "fresh" };
  };
  const staleDeadlineFor = (usage: CapturedUsage): number =>
    Math.min(usage.capturedAtMs + STALE_AFTER_MS, usage.usage.resetsAtMs);
  const staleExpirationAtMs = (): number | undefined =>
    capturedUsage?.freshness === "stale"
      ? staleDeadlineFor(capturedUsage)
      : undefined;
  const shouldAcquireDedicated = (nowMs: number): boolean =>
    capturedUsage === undefined ||
    nowMs - capturedUsage.capturedAtMs >= REFRESH_DEBOUNCE_MS;
  const reaction = (
    publication: WeeklyQuotaObservationReaction["publication"] = "preserve",
    acquireDedicated = false,
  ): WeeklyQuotaObservationReaction => ({
    observation:
      capturedUsage === undefined
        ? { kind: "none" }
        : {
            kind: "usage",
            usage: capturedUsage.usage,
            freshness: capturedUsage.freshness,
          },
    publication,
    staleExpirationAtMs: staleExpirationAtMs(),
    acquireDedicated,
  });
  const staleOrUnavailable = (
    nowMs: number,
  ): WeeklyQuotaObservationReaction => {
    if (capturedUsage === undefined) return reaction("replace");

    const deadline = staleDeadlineFor(capturedUsage);
    if (nowMs >= deadline) {
      clearUsage();
      return reaction("replace");
    }

    capturedUsage = { ...capturedUsage, freshness: "stale" };
    return reaction("replace");
  };

  return {
    advance: (event, nowMs) => {
      if (!Number.isFinite(nowMs)) {
        throw new RangeError("nowMs must be finite");
      }

      switch (event.kind) {
        case "passive-weekly-quota-observation": {
          const entries = entriesFromProviderFields(event.fields);
          if (entries === undefined) {
            discardAll();
            return reaction("replace");
          }

          let contributed = false;
          for (const [name, value] of entries) {
            const normalizedName = name.toLowerCase();
            if (!RATE_LIMIT_FIELD_NAMES.has(normalizedName)) continue;
            if (typeof value !== "string") {
              discardAll();
              return reaction("replace");
            }
            accumulatedFields[normalizedName] = value;
            contributed = true;
          }
          if (!contributed) {
            return reaction("preserve", shouldAcquireDedicated(nowMs));
          }

          for (const position of WINDOW_POSITIONS) {
            const usage = usageForPosition(
              accumulatedFields,
              capturedUsage?.usage,
              position,
            );
            if (usage === "malformed") {
              discardAll();
              return reaction("replace");
            }
            if (usage !== undefined) {
              recordUsage(usage, nowMs);
              return reaction("replace");
            }
          }
          return reaction();
        }

        case "dedicated-weekly-quota-acquisition": {
          const { result } = event;
          if (result.kind === "acquired") {
            recordUsage(result.usage, nowMs);
          } else if (result.kind === "temporary-failure") {
            return staleOrUnavailable(nowMs);
          } else if (result.kind === "malformed-observation") {
            discardAll();
          } else {
            clearUsage();
          }
          return reaction("replace");
        }

        case "dedicated-weekly-quota-acquisition-deferred":
          return staleOrUnavailable(nowMs);

        case "activity":
          return reaction("preserve", shouldAcquireDedicated(nowMs));

        case "account-selection-invalidated": {
          const hadUsage = capturedUsage !== undefined;
          discardAll();
          return reaction(hadUsage ? "replace" : "preserve");
        }

        case "stale-usage-expiration-reached":
          if (capturedUsage?.freshness !== "stale") return reaction();
          return staleOrUnavailable(nowMs);
      }
    },
  };
}
