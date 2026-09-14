import type {
  AcquiredWeeklyQuotaUsage,
  DedicatedWeeklyQuotaAcquisitionResult,
} from "./dedicated-weekly-quota-acquisition.ts";
import type { ProviderEvidenceProvenance } from "./provider-monitor.ts";
import {
  createStaleCapacityLifecycle,
  type StaleCapacityDeadline,
  type StaleCapacityLifecycleReaction,
  type StaleCapacityObservation,
} from "./stale-capacity-lifecycle.ts";

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
      readonly provenance: ProviderEvidenceProvenance;
    }
  | {
      readonly kind: "dedicated-weekly-quota-acquisition";
      readonly result: DedicatedWeeklyQuotaAcquisitionResult;
      readonly provenance: ProviderEvidenceProvenance;
    }
  | { readonly kind: "dedicated-weekly-quota-acquisition-deferred" }
  | { readonly kind: "activity" }
  | {
      readonly kind: "account-selection-invalidated";
      readonly credentialEpoch: number;
    }
  | {
      readonly kind: "account-selection-unavailable";
      readonly credentialEpoch: number;
    }
  | {
      readonly kind: "stale-capacity-expiration-reached";
      readonly deadline: StaleCapacityDeadline;
    }
  | { readonly kind: "session-ended" };

export type WeeklyQuotaObservationState =
  StaleCapacityObservation<WeeklyQuotaUsage>;

export interface WeeklyQuotaObservationReaction
  extends StaleCapacityLifecycleReaction<WeeklyQuotaUsage> {
  readonly acquireDedicated: boolean;
}

export interface WeeklyQuotaObservationReconciliation {
  /**
   * Applies events synchronously while accepting evidence by its session-local
   * provenance rather than completion order. Time must be a finite epoch
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
  let lastObservedAtMs: number | undefined;
  let credentialEpoch: number | undefined;
  let latestEvidenceSequence: number | undefined;
  const capacityLifecycle = createStaleCapacityLifecycle<WeeklyQuotaUsage>({
    staleExpiresAtMs: ({ capacity, observedAtMs }) =>
      Math.min(capacity.resetsAtMs, observedAtMs + STALE_AFTER_MS),
  });
  const discardAll = (kind: "unavailable" | "invalidated") => {
    accumulatedFields = {};
    lastObservedAtMs = undefined;
    return capacityLifecycle.advance({ kind });
  };
  const clearUsage = () => {
    lastObservedAtMs = undefined;
    return capacityLifecycle.advance({ kind: "unavailable" });
  };
  const recordUsage = (usage: WeeklyQuotaUsage, observedAtMs: number) => {
    accumulatedFields = {};
    lastObservedAtMs = observedAtMs;
    return capacityLifecycle.advance({
      kind: "observed",
      capacity: usage,
      observedAtMs,
    });
  };
  const capturedUsage = (): WeeklyQuotaUsage | undefined => {
    const observation = capacityLifecycle.current().observation;
    return observation.kind === "capacity" ? observation.capacity : undefined;
  };
  const shouldAcquireDedicated = (nowMs: number): boolean =>
    lastObservedAtMs === undefined ||
    nowMs - lastObservedAtMs >= REFRESH_DEBOUNCE_MS;
  const reaction = (
    lifecycleReaction: StaleCapacityLifecycleReaction<WeeklyQuotaUsage> = {
      ...capacityLifecycle.current(),
      publication: "preserve",
    },
    acquireDedicated = false,
  ): WeeklyQuotaObservationReaction => ({
    ...lifecycleReaction,
    acquireDedicated,
  });
  const staleOrUnavailable = (
    nowMs: number,
  ): WeeklyQuotaObservationReaction => {
    const result = capacityLifecycle.advance({
      kind: "temporarily-unavailable",
      nowMs,
    });
    if (result.observation.kind === "none") lastObservedAtMs = undefined;
    return reaction(result);
  };
  const assertPositiveSafeInteger = (value: number, name: string): void => {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  };
  const acceptEvidence = (provenance: ProviderEvidenceProvenance): boolean => {
    assertPositiveSafeInteger(
      provenance.credentialEpoch,
      "provider credential epoch",
    );
    assertPositiveSafeInteger(
      provenance.sequence,
      "provider evidence sequence",
    );
    if (credentialEpoch === undefined) {
      credentialEpoch = provenance.credentialEpoch;
    }
    if (
      provenance.credentialEpoch !== credentialEpoch ||
      (latestEvidenceSequence !== undefined &&
        provenance.sequence <= latestEvidenceSequence)
    ) {
      return false;
    }
    latestEvidenceSequence = provenance.sequence;
    return true;
  };
  const selectCredentialEpoch = (nextCredentialEpoch: number) => {
    assertPositiveSafeInteger(nextCredentialEpoch, "provider credential epoch");
    credentialEpoch = nextCredentialEpoch;
    latestEvidenceSequence = undefined;
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
            return acceptEvidence(event.provenance)
              ? reaction(discardAll("unavailable"))
              : reaction();
          }

          const recognizedEntries: Array<[string, string]> = [];
          for (const [name, value] of entries) {
            const normalizedName = name.toLowerCase();
            if (!RATE_LIMIT_FIELD_NAMES.has(normalizedName)) continue;
            if (typeof value !== "string") {
              return acceptEvidence(event.provenance)
                ? reaction(discardAll("unavailable"))
                : reaction();
            }
            recognizedEntries.push([normalizedName, value]);
          }
          if (recognizedEntries.length === 0) {
            return reaction(undefined, shouldAcquireDedicated(nowMs));
          }
          if (!acceptEvidence(event.provenance)) return reaction();
          for (const [name, value] of recognizedEntries) {
            accumulatedFields[name] = value;
          }

          for (const position of WINDOW_POSITIONS) {
            const usage = usageForPosition(
              accumulatedFields,
              capturedUsage(),
              position,
            );
            if (usage === "malformed") {
              return reaction(discardAll("unavailable"));
            }
            if (usage !== undefined) {
              return reaction(recordUsage(usage, nowMs));
            }
          }
          return reaction();
        }

        case "dedicated-weekly-quota-acquisition": {
          if (!acceptEvidence(event.provenance)) return reaction();
          const { result } = event;
          if (result.kind === "acquired") {
            return reaction(recordUsage(result.usage, nowMs));
          }
          if (result.kind === "temporary-failure") {
            return staleOrUnavailable(nowMs);
          }
          return reaction(
            result.kind === "malformed-observation"
              ? discardAll("unavailable")
              : clearUsage(),
          );
        }

        case "dedicated-weekly-quota-acquisition-deferred":
          return staleOrUnavailable(nowMs);

        case "activity":
          return reaction(undefined, shouldAcquireDedicated(nowMs));

        case "account-selection-invalidated":
          selectCredentialEpoch(event.credentialEpoch);
          return reaction(discardAll("invalidated"));

        case "account-selection-unavailable":
          selectCredentialEpoch(event.credentialEpoch);
          return reaction(discardAll("unavailable"));

        case "stale-capacity-expiration-reached": {
          const result = capacityLifecycle.advance({
            kind: "stale-expiration-reached",
            deadline: event.deadline,
            nowMs,
          });
          if (result.observation.kind === "none") lastObservedAtMs = undefined;
          return reaction(result);
        }

        case "session-ended":
          accumulatedFields = {};
          lastObservedAtMs = undefined;
          credentialEpoch = undefined;
          latestEvidenceSequence = undefined;
          return reaction(capacityLifecycle.advance({ kind: "session-ended" }));
      }
    },
  };
}
