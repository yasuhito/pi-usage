import { createHash } from "node:crypto";
import { Effect, Layer, type Scope } from "effect";

import type {
  AcquiredOpenRouterKeyCapacity,
  AcquireOpenRouterKeyCapacity,
  OpenRouterApiKey,
  OpenRouterKeyCapacityAcquisitionError,
} from "./openrouter-key-capacity-acquisition.ts";
import type { OpenRouterKeyCapacityStatus } from "./presentation.ts";
import {
  makeProviderMonitor,
  type ProviderAcquisitionHealth,
  type ProviderCapacityFacts,
  type ProviderMonitor,
  type ProviderMonitorAdapter,
  ProviderMonitorService,
  providerCredentialIdentity,
} from "./provider-monitor.ts";

const STALE_RETENTION_MS = 10 * 60_000;

export interface OpenRouterAuthentication {
  readonly auth: {
    readonly apiKey?: string;
  };
}

export interface OpenRouterProviderMonitorDependencies {
  readonly resolveAuthentication: () => Effect.Effect<
    OpenRouterAuthentication | undefined,
    unknown
  >;
  readonly acquireOpenRouterKeyCapacity: AcquireOpenRouterKeyCapacity;
  readonly publish: (
    status: OpenRouterKeyCapacityStatus,
  ) => Effect.Effect<void>;
  readonly random?: Effect.Effect<number>;
}

interface CapturedCapacity {
  readonly capacity: AcquiredOpenRouterKeyCapacity;
  readonly observedAtMs: number;
  readonly stale: boolean;
}

function makeOpenRouterProviderMonitorAdapter(
  dependencies: OpenRouterProviderMonitorDependencies,
): ProviderMonitorAdapter<
  OpenRouterApiKey,
  AcquiredOpenRouterKeyCapacity,
  OpenRouterKeyCapacityAcquisitionError,
  OpenRouterKeyCapacityStatus
> {
  let captured: CapturedCapacity | undefined;

  const capacityDeadline = (): number | undefined => {
    if (captured === undefined) return undefined;
    if (!captured.stale) return captured.capacity.validUntilMs;
    return Math.min(
      captured.observedAtMs + STALE_RETENTION_MS,
      captured.capacity.validUntilMs ?? Number.POSITIVE_INFINITY,
    );
  };

  const status = (): OpenRouterKeyCapacityStatus => {
    if (captured === undefined) return { kind: "unavailable" };
    return captured.capacity.kind === "limited"
      ? {
          kind: "openrouter-key-remaining-spend",
          remainingUsd: captured.capacity.remainingUsd,
          stale: captured.stale,
        }
      : { kind: "openrouter-key-no-limit", stale: captured.stale };
  };

  const facts = (
    publish: boolean,
    observationEvidence?: ProviderCapacityFacts<OpenRouterKeyCapacityStatus>["observationEvidence"],
    acquisitionHealth?: ProviderAcquisitionHealth,
  ): ProviderCapacityFacts<OpenRouterKeyCapacityStatus> => ({
    presentation: publish
      ? { kind: "replace", status: status() }
      : { kind: "preserve" },
    staleCapacityExpiresAtMs: capacityDeadline(),
    ...(observationEvidence === undefined ? {} : { observationEvidence }),
    ...(acquisitionHealth === undefined ? {} : { acquisitionHealth }),
  });

  const clear = (publish: boolean) => {
    captured = undefined;
    return facts(publish);
  };

  const temporarilyUnavailable = (
    nowMs: number,
    providerNotBeforeMs?: number,
  ): ProviderCapacityFacts<OpenRouterKeyCapacityStatus> => {
    if (captured !== undefined) {
      captured = { ...captured, stale: true };
      const deadline = capacityDeadline();
      if (deadline === undefined || nowMs >= deadline) captured = undefined;
    }
    // Preserve backoff without scheduling a request outside lifecycle triggers.
    return facts(true, undefined, {
      kind: "trigger-deferred",
      providerNotBeforeMs,
    });
  };

  return {
    credentialVerification: "before-and-after",
    resolveCredential: Effect.suspend(dependencies.resolveAuthentication).pipe(
      Effect.catchAllCause(() => Effect.succeed(undefined)),
      Effect.map((authentication) => {
        const key = authentication?.auth.apiKey?.trim();
        if (key === undefined || key === "") {
          return {
            kind: "unavailable" as const,
            acceptPassiveObservation: false,
          };
        }
        return {
          kind: "available" as const,
          identity: providerCredentialIdentity(
            createHash("sha256").update(key).digest("hex"),
          ),
          credential: key as OpenRouterApiKey,
          acceptPassiveObservation: false,
        };
      }),
    ),
    acquire: dependencies.acquireOpenRouterKeyCapacity,
    advance: (event) =>
      Effect.sync(() => {
        switch (event.kind) {
          case "credential-observed": {
            if (event.continuity === "unchanged") return facts(false);
            const hadCapacity = captured !== undefined;
            return clear(!event.credentialAvailable || hadCapacity);
          }
          case "acquisition-completed": {
            if (
              event.exit.kind === "failed" &&
              event.exit.error._tag === "OpenRouterAuthenticationRejected" &&
              !event.authenticationRefreshUsed
            ) {
              return facts(false, undefined, { kind: "credential-rejected" });
            }
            if (
              event.currentIdentity === undefined ||
              event.currentIdentity !== event.startedIdentity
            ) {
              return facts(false, undefined, { kind: "healthy" });
            }
            if (event.exit.kind === "acquired") {
              captured = {
                capacity: event.exit.value,
                observedAtMs: event.nowMs,
                stale: false,
              };
              return facts(true, "adequate", { kind: "healthy" });
            }
            const error = event.exit.error;
            switch (error._tag) {
              case "TemporaryOpenRouterKeyCapacityFailure":
                return temporarilyUnavailable(event.nowMs, error.retryAtMs);
              case "MalformedOpenRouterKeyCapacity":
                return temporarilyUnavailable(event.nowMs);
              case "OpenRouterAuthenticationRejected":
                return {
                  ...clear(true),
                  acquisitionHealth: { kind: "healthy" },
                };
              case "PermanentOpenRouterKeyCapacityFailure":
                return {
                  ...clear(true),
                  acquisitionHealth: { kind: "terminal" },
                };
            }
            throw new TypeError("unknown OpenRouter acquisition failure");
          }
          case "activity-observed":
            return facts(false, "inadequate");
          case "passive-observation":
          case "acquisition-deferred":
            return facts(false);
          case "stale-expiration-reached": {
            if (
              captured === undefined ||
              capacityDeadline() !== event.deadlineMs ||
              event.nowMs < event.deadlineMs
            ) {
              return facts(false);
            }
            return clear(true);
          }
          case "session-ended":
            return clear(false);
        }
      }),
    finalize: Effect.void,
  };
}

export function makeOpenRouterProviderMonitor(
  dependencies: OpenRouterProviderMonitorDependencies,
): Effect.Effect<ProviderMonitor, never, Scope.Scope> {
  return makeProviderMonitor<
    OpenRouterApiKey,
    AcquiredOpenRouterKeyCapacity,
    OpenRouterKeyCapacityAcquisitionError,
    OpenRouterKeyCapacityStatus
  >(makeOpenRouterProviderMonitorAdapter(dependencies), {
    ...dependencies,
    polling: { kind: "disabled" },
  });
}

export const openRouterProviderMonitorLayer = (
  dependencies: OpenRouterProviderMonitorDependencies,
) =>
  Layer.scoped(
    ProviderMonitorService,
    makeOpenRouterProviderMonitor(dependencies),
  );
