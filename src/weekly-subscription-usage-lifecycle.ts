export interface WeeklySubscriptionUsageWithReset {
  readonly resetsAtMs: number;
}

export type WeeklySubscriptionUsageLifecycleEvent<
  Usage extends WeeklySubscriptionUsageWithReset,
> =
  | {
      readonly kind: "observed";
      readonly usage: Usage;
      readonly observedAtMs: number;
    }
  | { readonly kind: "temporarily-unavailable"; readonly nowMs: number }
  | {
      readonly kind: "stale-expiration-reached";
      readonly deadlineMs: number;
      readonly nowMs: number;
    }
  | { readonly kind: "invalidated" }
  | { readonly kind: "session-ended" };

export type WeeklySubscriptionUsageObservation<Usage> =
  | { readonly kind: "none" }
  | {
      readonly kind: "usage";
      readonly usage: Usage;
      readonly freshness: "fresh" | "stale";
    };

export interface WeeklySubscriptionUsageLifecycleState<Usage> {
  readonly observation: WeeklySubscriptionUsageObservation<Usage>;
  readonly staleExpirationAtMs: number | undefined;
}

export interface WeeklySubscriptionUsageLifecycleReaction<Usage>
  extends WeeklySubscriptionUsageLifecycleState<Usage> {
  readonly publication: "preserve" | "replace";
}

export interface WeeklySubscriptionUsageLifecycle<
  Usage extends WeeklySubscriptionUsageWithReset,
> {
  readonly current: () => WeeklySubscriptionUsageLifecycleState<Usage>;
  readonly advance: (
    event: WeeklySubscriptionUsageLifecycleEvent<Usage>,
  ) => WeeklySubscriptionUsageLifecycleReaction<Usage>;
}

export interface WeeklySubscriptionUsageLifecyclePolicy {
  /** Omit to retain stale usage until its reported reset time. */
  readonly staleRetentionMs?: number;
}

interface CapturedUsage<Usage extends WeeklySubscriptionUsageWithReset> {
  readonly usage: Usage;
  readonly observedAtMs: number;
  readonly freshness: "fresh" | "stale";
}

/** Owns one provider's fresh, stale, and expired usage progression. */
export function createWeeklySubscriptionUsageLifecycle<
  Usage extends WeeklySubscriptionUsageWithReset,
>(
  policy: WeeklySubscriptionUsageLifecyclePolicy,
): WeeklySubscriptionUsageLifecycle<Usage> {
  let captured: CapturedUsage<Usage> | undefined;

  const staleExpirationAtMs = (usage: CapturedUsage<Usage>) =>
    Math.min(
      usage.usage.resetsAtMs,
      policy.staleRetentionMs === undefined
        ? usage.usage.resetsAtMs
        : usage.observedAtMs + policy.staleRetentionMs,
    );

  const current = (): WeeklySubscriptionUsageLifecycleState<Usage> => ({
    observation:
      captured === undefined
        ? { kind: "none" }
        : {
            kind: "usage",
            usage: captured.usage,
            freshness: captured.freshness,
          },
    staleExpirationAtMs:
      captured?.freshness === "stale"
        ? staleExpirationAtMs(captured)
        : undefined,
  });
  const reaction = (
    publication: "preserve" | "replace",
  ): WeeklySubscriptionUsageLifecycleReaction<Usage> => ({
    ...current(),
    publication,
  });

  return {
    current,
    advance: (event) => {
      switch (event.kind) {
        case "observed":
          captured = {
            usage: event.usage,
            observedAtMs: event.observedAtMs,
            freshness: "fresh",
          };
          return reaction("replace");
        case "temporarily-unavailable": {
          if (captured === undefined) return reaction("replace");
          if (event.nowMs >= staleExpirationAtMs(captured)) {
            captured = undefined;
            return reaction("replace");
          }
          captured = { ...captured, freshness: "stale" };
          return reaction("replace");
        }
        case "stale-expiration-reached": {
          if (
            captured?.freshness !== "stale" ||
            staleExpirationAtMs(captured) !== event.deadlineMs ||
            event.nowMs < event.deadlineMs
          ) {
            return reaction("preserve");
          }
          captured = undefined;
          return reaction("replace");
        }
        case "invalidated": {
          const hadUsage = captured !== undefined;
          captured = undefined;
          return reaction(hadUsage ? "replace" : "preserve");
        }
        case "session-ended":
          captured = undefined;
          return reaction("preserve");
      }
    },
  };
}
