import type {
  AcquireDedicatedWeeklyQuotaUsage,
  CodexCredential,
  DedicatedWeeklyQuotaAcquisitionResult,
} from "./dedicated-weekly-quota-acquisition.ts";
import type { QuotaStatus } from "./presentation.ts";
import {
  createWeeklyQuotaObservationReconciliation,
  type WeeklyQuotaObservationReaction,
} from "./weekly-quota-observation-reconciliation.ts";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export type CodexCredentialResolution =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "available"; readonly credential: CodexCredential };

export interface WeeklyQuotaUsageLifecycleDependencies {
  readonly now: () => number;
  readonly random: () => number;
  readonly schedule: (callback: () => void, delay: number) => () => void;
  readonly resolveCredential: () => Promise<CodexCredentialResolution>;
  readonly acquireDedicatedWeeklyQuotaUsage: AcquireDedicatedWeeklyQuotaUsage;
  readonly publish: (status: QuotaStatus | undefined) => void;
  readonly startPolling: (refresh: () => void) => () => void;
}

export interface WeeklyQuotaUsageLifecycle {
  readonly start: () => Promise<void>;
  readonly observeCodexResponse: (
    headers: Readonly<Record<string, unknown>>,
  ) => void;
  readonly refreshAfterActivity: () => Promise<void>;
  readonly refreshForAccountChange: () => Promise<void>;
  readonly stop: () => void;
}

export function createWeeklyQuotaUsageLifecycle(
  dependencies: WeeklyQuotaUsageLifecycleDependencies,
): WeeklyQuotaUsageLifecycle {
  let stopPolling: (() => void) | undefined;
  let cancelStaleExpiration: (() => void) | undefined;
  let scheduledStaleExpirationAtMs: number | undefined;
  let activeController: AbortController | undefined;
  let shuttingDown = false;
  let credentialAvailable = false;
  let nextAttemptAt = 0;
  let consecutiveFailures = 0;
  let currentAccountId: string | undefined;
  let accountResolutionsInFlight = 0;
  const observationReconciliation =
    createWeeklyQuotaObservationReconciliation();

  const applyObservationReaction = (
    reaction: WeeklyQuotaObservationReaction,
  ): boolean => {
    if (reaction.staleExpirationAtMs !== scheduledStaleExpirationAtMs) {
      cancelStaleExpiration?.();
      cancelStaleExpiration = undefined;
      scheduledStaleExpirationAtMs = reaction.staleExpirationAtMs;

      if (scheduledStaleExpirationAtMs !== undefined) {
        const deadline = scheduledStaleExpirationAtMs;
        cancelStaleExpiration = dependencies.schedule(
          () => {
            cancelStaleExpiration = undefined;
            scheduledStaleExpirationAtMs = undefined;
            applyObservationReaction(
              observationReconciliation.advance(
                { kind: "stale-usage-expiration-reached" },
                dependencies.now(),
              ),
            );
          },
          Math.max(0, deadline - dependencies.now()),
        );
      }
    }

    if (reaction.publication === "replace") {
      if (reaction.observation.kind === "none") {
        dependencies.publish({ kind: "unavailable" });
      } else {
        dependencies.publish({
          kind: "available",
          usedPercent: reaction.observation.usage.usedPercent,
          stale: reaction.observation.freshness === "stale",
        });
      }
    }

    return reaction.acquireDedicated;
  };

  const invalidateAccountObservation = (): void => {
    applyObservationReaction(
      observationReconciliation.advance(
        { kind: "account-selection-invalidated" },
        dependencies.now(),
      ),
    );
  };
  const selectAccount = (accountId: string): void => {
    if (currentAccountId === accountId) return;
    currentAccountId = accountId;
    invalidateAccountObservation();
    nextAttemptAt = 0;
    consecutiveFailures = 0;
  };
  const clearForMissingCredential = (): void => {
    credentialAvailable = false;
    currentAccountId = undefined;
    invalidateAccountObservation();
    dependencies.publish(undefined);
  };
  const clearForInvalidCredential = (): void => {
    credentialAvailable = true;
    currentAccountId = undefined;
    invalidateAccountObservation();
    nextAttemptAt = 0;
    consecutiveFailures = 0;
    dependencies.publish({ kind: "unavailable" });
  };
  const applyCredentialResolution = (
    resolution: CodexCredentialResolution,
  ): CodexCredential | undefined => {
    if (resolution.kind === "missing") {
      clearForMissingCredential();
      return undefined;
    }
    if (resolution.kind === "invalid") {
      clearForInvalidCredential();
      return undefined;
    }

    credentialAvailable = true;
    selectAccount(resolution.credential.accountId);
    return resolution.credential;
  };

  const recordTemporaryFailure = (retryAtMs: number | undefined): void => {
    const now = dependencies.now();
    consecutiveFailures += 1;
    if (retryAtMs !== undefined && Number.isFinite(retryAtMs)) {
      nextAttemptAt = retryAtMs;
    }
    if (nextAttemptAt <= now) {
      const baseDelay = Math.min(
        MAX_BACKOFF_MS,
        INITIAL_BACKOFF_MS * 2 ** (consecutiveFailures - 1),
      );
      const jitter = 0.5 + dependencies.random();
      nextAttemptAt = now + baseDelay * jitter;
    }
  };

  const applyDedicatedResult = (
    result: DedicatedWeeklyQuotaAcquisitionResult,
  ): void => {
    if (result.kind === "temporary-failure") {
      recordTemporaryFailure(result.retryAtMs);
    } else {
      nextAttemptAt = 0;
      consecutiveFailures = 0;
    }
    applyObservationReaction(
      observationReconciliation.advance(
        { kind: "dedicated-weekly-quota-acquisition", result },
        dependencies.now(),
      ),
    );
  };

  let inFlight: Promise<void> | undefined;
  const performRefresh = async (
    signal: AbortSignal,
    ignoreBackoff: boolean,
  ): Promise<void> => {
    try {
      const resolution = await dependencies.resolveCredential();
      if (shuttingDown) return;
      const credential = applyCredentialResolution(resolution);
      if (credential === undefined) return;

      if (!ignoreBackoff && dependencies.now() < nextAttemptAt) {
        applyObservationReaction(
          observationReconciliation.advance(
            { kind: "dedicated-weekly-quota-acquisition-deferred" },
            dependencies.now(),
          ),
        );
        return;
      }
      let result = await dependencies.acquireDedicatedWeeklyQuotaUsage(
        credential,
        signal,
      );
      if (result.kind === "authentication-rejected") {
        const refreshedResolution = await dependencies.resolveCredential();
        if (shuttingDown) return;
        const refreshedCredential =
          applyCredentialResolution(refreshedResolution);
        if (refreshedCredential === undefined) return;
        result = await dependencies.acquireDedicatedWeeklyQuotaUsage(
          refreshedCredential,
          signal,
        );
      }
      if (shuttingDown || signal.aborted) return;

      applyDedicatedResult(result);
    } catch {
      if (shuttingDown || signal.aborted) return;
      applyDedicatedResult({
        kind: "temporary-failure",
        retryAtMs: undefined,
      });
    }
  };

  const refresh = (ignoreBackoff = false): Promise<void> => {
    if (shuttingDown) return Promise.resolve();
    if (inFlight !== undefined) {
      if (!ignoreBackoff) return inFlight;
      activeController?.abort();
      return inFlight.then(() => refresh(true));
    }
    const controller = new AbortController();
    activeController = controller;
    const current = performRefresh(controller.signal, ignoreBackoff).finally(
      () => {
        if (inFlight === current) {
          inFlight = undefined;
          activeController = undefined;
        }
      },
    );
    inFlight = current;
    return current;
  };

  const updatePolling = (): void => {
    if (shuttingDown || !credentialAvailable) {
      stopPolling?.();
      stopPolling = undefined;
      return;
    }
    stopPolling ??= dependencies.startPolling(() => {
      void refreshAndUpdatePolling();
    });
  };
  const refreshAndUpdatePolling = async (
    ignoreBackoff = false,
  ): Promise<void> => {
    await refresh(ignoreBackoff);
    updatePolling();
  };

  return {
    start: async () => {
      dependencies.publish({ kind: "loading" });
      await refreshAndUpdatePolling();
    },
    observeCodexResponse: (headers) => {
      if (!credentialAvailable || accountResolutionsInFlight > 0) return;
      const acquireDedicated = applyObservationReaction(
        observationReconciliation.advance(
          { kind: "passive-weekly-quota-observation", fields: headers },
          dependencies.now(),
        ),
      );
      if (acquireDedicated) void refresh();
    },
    refreshAfterActivity: async () => {
      const acquireDedicated = applyObservationReaction(
        observationReconciliation.advance(
          { kind: "activity" },
          dependencies.now(),
        ),
      );
      if (acquireDedicated) await refreshAndUpdatePolling();
    },
    refreshForAccountChange: async () => {
      accountResolutionsInFlight += 1;
      try {
        await refreshAndUpdatePolling(true);
      } finally {
        accountResolutionsInFlight -= 1;
      }
    },
    stop: () => {
      shuttingDown = true;
      activeController?.abort();
      stopPolling?.();
      stopPolling = undefined;
      credentialAvailable = false;
      currentAccountId = undefined;
      cancelStaleExpiration?.();
      cancelStaleExpiration = undefined;
      scheduledStaleExpirationAtMs = undefined;
    },
  };
}
