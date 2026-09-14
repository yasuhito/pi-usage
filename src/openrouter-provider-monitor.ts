import { createHash } from "node:crypto";
import { Effect, Layer, type Scope } from "effect";

import type {
  AcquiredOpenRouterAccountCreditBalance,
  AcquireOpenRouterAccountCreditBalance,
  OpenRouterAccountCreditBalanceAcquisitionError,
} from "./openrouter-account-credit-balance-acquisition.ts";
import type {
  OpenRouterManagementKey,
  ResolveOpenRouterManagementKey,
} from "./openrouter-management-key-resolution.ts";
import type { OpenRouterAccountCreditBalanceStatus } from "./presentation.ts";
import {
  makeProviderMonitor,
  type ProviderAcquisitionHealth,
  type ProviderCapacityFacts,
  type ProviderMonitor,
  type ProviderMonitorAdapter,
  ProviderMonitorService,
  providerCredentialIdentity,
} from "./provider-monitor.ts";
import {
  createStaleCapacityLifecycle,
  type StaleCapacityLifecycleReaction,
} from "./stale-capacity-lifecycle.ts";

const STALE_RETENTION_MS = 10 * 60_000;

export interface OpenRouterProviderMonitorDependencies {
  readonly resolveManagementKey: ResolveOpenRouterManagementKey;
  readonly acquireOpenRouterAccountCreditBalance: AcquireOpenRouterAccountCreditBalance;
  readonly publish: (
    status: OpenRouterAccountCreditBalanceStatus,
  ) => Effect.Effect<void>;
  readonly random?: Effect.Effect<number>;
}

function makeOpenRouterProviderMonitorAdapter(
  dependencies: OpenRouterProviderMonitorDependencies,
): ProviderMonitorAdapter<
  OpenRouterManagementKey,
  AcquiredOpenRouterAccountCreditBalance,
  OpenRouterAccountCreditBalanceAcquisitionError,
  OpenRouterAccountCreditBalanceStatus
> {
  const balanceLifecycle =
    createStaleCapacityLifecycle<AcquiredOpenRouterAccountCreditBalance>({
      staleExpiresAtMs: ({ observedAtMs }) => observedAtMs + STALE_RETENTION_MS,
    });

  const currentReaction =
    (): StaleCapacityLifecycleReaction<AcquiredOpenRouterAccountCreditBalance> => ({
      ...balanceLifecycle.current(),
      publication: "preserve",
    });

  const facts = (
    reaction: StaleCapacityLifecycleReaction<AcquiredOpenRouterAccountCreditBalance>,
    observationEvidence?: ProviderCapacityFacts<OpenRouterAccountCreditBalanceStatus>["observationEvidence"],
    acquisitionHealth?: ProviderAcquisitionHealth,
  ): ProviderCapacityFacts<OpenRouterAccountCreditBalanceStatus> => {
    const observation = reaction.observation;
    const status: OpenRouterAccountCreditBalanceStatus =
      observation.kind === "none"
        ? { kind: "unavailable" }
        : {
            kind: "openrouter-account-credit-balance",
            balanceUsd: observation.capacity.balanceUsd,
            stale: observation.freshness === "stale",
          };
    return {
      presentation:
        reaction.publication === "replace"
          ? { kind: "replace", status }
          : { kind: "preserve" },
      staleCapacityExpiration: reaction.staleExpiration,
      ...(observationEvidence === undefined ? {} : { observationEvidence }),
      ...(acquisitionHealth === undefined ? {} : { acquisitionHealth }),
    };
  };

  const clear = (kind: "unavailable" | "invalidated") =>
    facts(balanceLifecycle.advance({ kind }));

  const temporarilyUnavailable = (
    nowMs: number,
    providerNotBeforeMs?: number,
  ): ProviderCapacityFacts<OpenRouterAccountCreditBalanceStatus> =>
    facts(
      balanceLifecycle.advance({ kind: "temporarily-unavailable", nowMs }),
      undefined,
      { kind: "trigger-deferred", providerNotBeforeMs },
    );

  return {
    credentialVerification: "before",
    resolveCredential: Effect.suspend(dependencies.resolveManagementKey).pipe(
      Effect.map((key) =>
        key === undefined
          ? {
              kind: "unavailable" as const,
              acceptPassiveObservation: false,
            }
          : {
              kind: "available" as const,
              identity: providerCredentialIdentity(
                createHash("sha256").update(key).digest("hex"),
              ),
              credential: key,
              acceptPassiveObservation: false,
            },
      ),
    ),
    acquire: dependencies.acquireOpenRouterAccountCreditBalance,
    advance: (event) =>
      Effect.sync(() => {
        switch (event.kind) {
          case "credential-observed": {
            if (event.continuity === "unchanged")
              return facts(currentReaction());
            return clear(
              event.credentialAvailable ? "invalidated" : "unavailable",
            );
          }
          case "acquisition-completed": {
            if (
              event.currentIdentity === undefined ||
              event.currentIdentity !== event.startedIdentity
            ) {
              return facts(currentReaction(), undefined, { kind: "healthy" });
            }
            if (event.exit.kind === "acquired") {
              return facts(
                balanceLifecycle.advance({
                  kind: "observed",
                  capacity: event.exit.value,
                  observedAtMs: event.nowMs,
                }),
                "adequate",
                { kind: "healthy" },
              );
            }
            const error = event.exit.error;
            switch (error._tag) {
              case "TemporaryOpenRouterAccountCreditBalanceFailure":
                return temporarilyUnavailable(event.nowMs, error.retryAtMs);
              case "MalformedOpenRouterAccountCreditBalance":
                return temporarilyUnavailable(event.nowMs);
              case "OpenRouterManagementAuthenticationRejected":
                return {
                  ...clear("unavailable"),
                  acquisitionHealth: { kind: "healthy" },
                };
              case "PermanentOpenRouterAccountCreditBalanceFailure":
                return {
                  ...clear("unavailable"),
                  acquisitionHealth: { kind: "terminal" },
                };
            }
            throw new TypeError("unknown OpenRouter acquisition failure");
          }
          case "activity-observed":
            return facts(currentReaction(), "inadequate");
          case "passive-observation":
          case "acquisition-deferred":
            return facts(currentReaction());
          case "stale-expiration-reached":
            return facts(
              balanceLifecycle.advance({
                kind: "stale-expiration-reached",
                deadline: event.deadline,
                nowMs: event.nowMs,
              }),
            );
          case "session-ended":
            return facts(balanceLifecycle.advance({ kind: "session-ended" }));
        }
      }),
    finalize: Effect.void,
  };
}

export function makeOpenRouterProviderMonitor(
  dependencies: OpenRouterProviderMonitorDependencies,
): Effect.Effect<ProviderMonitor, never, Scope.Scope> {
  return makeProviderMonitor<
    OpenRouterManagementKey,
    AcquiredOpenRouterAccountCreditBalance,
    OpenRouterAccountCreditBalanceAcquisitionError,
    OpenRouterAccountCreditBalanceStatus
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
