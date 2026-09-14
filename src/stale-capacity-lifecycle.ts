declare const staleCapacityDeadlineBrand: unique symbol;

/** An in-process expiration identity issued by a Stale capacity lifecycle. */
export interface StaleCapacityDeadline {
  readonly expiresAtMs: number;
  readonly [staleCapacityDeadlineBrand]: true;
}

export type StaleCapacityObservation<Capacity> =
  | { readonly kind: "none" }
  | {
      readonly kind: "capacity";
      readonly capacity: Capacity;
      readonly freshness: "fresh" | "stale";
    };

export interface StaleCapacityLifecycleState<Capacity> {
  readonly observation: StaleCapacityObservation<Capacity>;
  readonly staleExpiration: StaleCapacityDeadline | undefined;
}

export interface StaleCapacityLifecycleReaction<Capacity>
  extends StaleCapacityLifecycleState<Capacity> {
  readonly publication: "preserve" | "replace";
}

export interface StaleCapacityLifecyclePolicy<Capacity> {
  readonly staleExpiresAtMs: (observation: {
    readonly capacity: Capacity;
    readonly observedAtMs: number;
  }) => number;
}

export type StaleCapacityLifecycleEvent<Capacity> =
  | {
      readonly kind: "observed";
      readonly capacity: Capacity;
      readonly observedAtMs: number;
    }
  | { readonly kind: "temporarily-unavailable"; readonly nowMs: number }
  | { readonly kind: "unavailable" }
  | { readonly kind: "invalidated" }
  | {
      readonly kind: "stale-expiration-reached";
      readonly deadline: StaleCapacityDeadline;
      readonly nowMs: number;
    }
  | { readonly kind: "session-ended" };

export interface StaleCapacityLifecycle<Capacity> {
  readonly current: () => StaleCapacityLifecycleState<Capacity>;
  readonly advance: (
    event: StaleCapacityLifecycleEvent<Capacity>,
  ) => StaleCapacityLifecycleReaction<Capacity>;
}

interface CapturedCapacity<Capacity> {
  readonly capacity: Capacity;
  readonly expiresAtMs: number;
  readonly freshness: "fresh" | "stale";
  readonly staleExpiration: StaleCapacityDeadline | undefined;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

/** Owns one provider's fresh, stale, expired, and ended capacity progression. */
export function createStaleCapacityLifecycle<Capacity>(
  policy: StaleCapacityLifecyclePolicy<Capacity>,
): StaleCapacityLifecycle<Capacity> {
  let captured: CapturedCapacity<Capacity> | undefined;
  let ended = false;

  const current = (): StaleCapacityLifecycleState<Capacity> => ({
    observation:
      captured === undefined
        ? { kind: "none" }
        : {
            kind: "capacity",
            capacity: captured.capacity,
            freshness: captured.freshness,
          },
    staleExpiration: captured?.staleExpiration,
  });
  const reaction = (
    publication: "preserve" | "replace",
  ): StaleCapacityLifecycleReaction<Capacity> => ({
    ...current(),
    publication,
  });

  return {
    current,
    advance: (event) => {
      if (ended) return reaction("preserve");

      switch (event.kind) {
        case "observed": {
          requireFinite(event.observedAtMs, "observedAtMs");
          const expiresAtMs = policy.staleExpiresAtMs({
            capacity: event.capacity,
            observedAtMs: event.observedAtMs,
          });
          requireFinite(expiresAtMs, "stale expiration");
          captured = {
            capacity: event.capacity,
            expiresAtMs,
            freshness: "fresh",
            staleExpiration: undefined,
          };
          return reaction("replace");
        }
        case "temporarily-unavailable": {
          requireFinite(event.nowMs, "nowMs");
          if (captured === undefined) return reaction("replace");
          if (event.nowMs >= captured.expiresAtMs) {
            captured = undefined;
            return reaction("replace");
          }
          const staleExpiration =
            captured.staleExpiration ??
            (Object.freeze({
              expiresAtMs: captured.expiresAtMs,
            }) as StaleCapacityDeadline);
          captured = {
            ...captured,
            freshness: "stale",
            staleExpiration,
          };
          return reaction("replace");
        }
        case "stale-expiration-reached": {
          requireFinite(event.nowMs, "nowMs");
          if (
            captured?.freshness !== "stale" ||
            captured.staleExpiration !== event.deadline ||
            event.nowMs < event.deadline.expiresAtMs
          ) {
            return reaction("preserve");
          }
          captured = undefined;
          return reaction("replace");
        }
        case "unavailable":
          captured = undefined;
          return reaction("replace");
        case "invalidated": {
          const hadCapacity = captured !== undefined;
          captured = undefined;
          return reaction(hadCapacity ? "replace" : "preserve");
        }
        case "session-ended":
          captured = undefined;
          ended = true;
          return reaction("preserve");
      }
    },
  };
}
