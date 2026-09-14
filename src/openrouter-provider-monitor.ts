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

const STALE_RETENTION_MS = 10 * 60_000;

export interface OpenRouterProviderMonitorDependencies {
  readonly resolveManagementKey: ResolveOpenRouterManagementKey;
  readonly acquireOpenRouterAccountCreditBalance: AcquireOpenRouterAccountCreditBalance;
  readonly publish: (
    status: OpenRouterAccountCreditBalanceStatus,
  ) => Effect.Effect<void>;
  readonly random?: Effect.Effect<number>;
}

interface CapturedBalance {
  readonly balance: AcquiredOpenRouterAccountCreditBalance;
  readonly observedAtMs: number;
  readonly stale: boolean;
}

function makeOpenRouterProviderMonitorAdapter(
  dependencies: OpenRouterProviderMonitorDependencies,
): ProviderMonitorAdapter<
  OpenRouterManagementKey,
  AcquiredOpenRouterAccountCreditBalance,
  OpenRouterAccountCreditBalanceAcquisitionError,
  OpenRouterAccountCreditBalanceStatus
> {
  let captured: CapturedBalance | undefined;

  const staleDeadline = () =>
    captured?.stale === true
      ? captured.observedAtMs + STALE_RETENTION_MS
      : undefined;

  const status = (): OpenRouterAccountCreditBalanceStatus =>
    captured === undefined
      ? { kind: "unavailable" }
      : {
          kind: "openrouter-account-credit-balance",
          balanceUsd: captured.balance.balanceUsd,
          stale: captured.stale,
        };

  const facts = (
    publish: boolean,
    observationEvidence?: ProviderCapacityFacts<OpenRouterAccountCreditBalanceStatus>["observationEvidence"],
    acquisitionHealth?: ProviderAcquisitionHealth,
  ): ProviderCapacityFacts<OpenRouterAccountCreditBalanceStatus> => ({
    presentation: publish
      ? { kind: "replace", status: status() }
      : { kind: "preserve" },
    staleCapacityExpiresAtMs: staleDeadline(),
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
  ): ProviderCapacityFacts<OpenRouterAccountCreditBalanceStatus> => {
    if (captured !== undefined) {
      captured = { ...captured, stale: true };
      const deadline = staleDeadline();
      if (deadline === undefined || nowMs >= deadline) captured = undefined;
    }
    return facts(true, undefined, {
      kind: "trigger-deferred",
      providerNotBeforeMs,
    });
  };

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
            if (event.continuity === "unchanged") return facts(false);
            const hadBalance = captured !== undefined;
            return clear(!event.credentialAvailable || hadBalance);
          }
          case "acquisition-completed": {
            if (
              event.currentIdentity === undefined ||
              event.currentIdentity !== event.startedIdentity
            ) {
              return facts(false, undefined, { kind: "healthy" });
            }
            if (event.exit.kind === "acquired") {
              captured = {
                balance: event.exit.value,
                observedAtMs: event.nowMs,
                stale: false,
              };
              return facts(true, "adequate", { kind: "healthy" });
            }
            const error = event.exit.error;
            switch (error._tag) {
              case "TemporaryOpenRouterAccountCreditBalanceFailure":
                return temporarilyUnavailable(event.nowMs, error.retryAtMs);
              case "MalformedOpenRouterAccountCreditBalance":
                return temporarilyUnavailable(event.nowMs);
              case "OpenRouterManagementAuthenticationRejected":
                return {
                  ...clear(true),
                  acquisitionHealth: { kind: "healthy" },
                };
              case "PermanentOpenRouterAccountCreditBalanceFailure":
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
              captured?.stale !== true ||
              staleDeadline() !== event.deadlineMs ||
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
