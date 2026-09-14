import { Effect, Exit, Fiber, Scope } from "effect";

import {
  type MonitoredProvider,
  type MountedMonitoredProvider,
  mountMonitoredProvider,
} from "./monitored-provider.ts";
import type { ProviderCapacityPresentation } from "./presentation.ts";
import type { ProviderMonitor } from "./provider-monitor.ts";

export interface MonitoredProviderCapacitySessionDependencies {
  readonly providers: ReadonlyArray<MonitoredProvider>;
  readonly now: Effect.Effect<number>;
  readonly present: (
    capacities: ReadonlyArray<ProviderCapacityPresentation>,
  ) => Effect.Effect<void>;
}

export interface MonitoredProviderCapacitySession {
  readonly start: (
    dependencies: MonitoredProviderCapacitySessionDependencies,
  ) => Effect.Effect<void>;
  readonly observeResponse: (
    piProviderId: string,
    responseHeaders: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly refreshAfterActivity: (piProviderId: string) => Effect.Effect<void>;
  readonly refreshForAccountChange: Effect.Effect<void>;
  readonly shutdown: Effect.Effect<void>;
}

interface Session {
  readonly id: number;
  readonly scope: Scope.CloseableScope;
  readonly mountedProviders: ReadonlyArray<MountedMonitoredProvider>;
  readonly monitors: ReadonlyArray<ProviderMonitor>;
  readonly monitorsByPiProviderId: ReadonlyMap<string, ProviderMonitor>;
}

function ensureUniqueProviderIds(
  providers: ReadonlyArray<MonitoredProvider>,
): Effect.Effect<void> {
  return Effect.sync(() => {
    const ids = new Set<string>();
    for (const provider of providers) {
      if (provider.piProviderId.trim() === "") {
        throw new TypeError("monitored provider id must not be empty");
      }
      if (ids.has(provider.piProviderId)) {
        throw new TypeError(
          `duplicate monitored provider id: ${provider.piProviderId}`,
        );
      }
      ids.add(provider.piProviderId);
    }
  });
}

/** Owns replacement, scoped monitor lifetime, routing, and late-work suppression. */
export function makeMonitoredProviderCapacitySession(): Effect.Effect<MonitoredProviderCapacitySession> {
  return Effect.gen(function* () {
    const transitionGate = yield* Effect.makeSemaphore(1);
    let session: Session | undefined;
    let nextSessionId = 0;

    const presentRoster = (
      sessionId: number,
      dependencies: MonitoredProviderCapacitySessionDependencies,
      mountedProviders: ReadonlyArray<MountedMonitoredProvider>,
      beforePresent: Effect.Effect<void> = Effect.void,
    ) =>
      Effect.gen(function* () {
        if (session?.id !== sessionId) return;
        const now = yield* dependencies.now;
        if (session?.id !== sessionId) return;
        yield* beforePresent;
        yield* dependencies.present(
          mountedProviders.map((provider) => provider.present(now)),
        );
      });

    const closeSession = (candidate: Session | undefined) =>
      Effect.gen(function* () {
        if (candidate === undefined) return;
        if (session === candidate) session = undefined;
        yield* Scope.close(candidate.scope, Exit.void);
      });

    const runInSessionScope = (
      candidate: Session,
      effect: Effect.Effect<void>,
    ) =>
      Effect.suspend(() => {
        if (session !== candidate) return Effect.void;
        return Effect.forkIn(
          effect.pipe(Effect.catchAllCause(() => Effect.void)),
          candidate.scope,
        ).pipe(Effect.flatMap(Fiber.await), Effect.asVoid);
      });

    const start = (
      dependencies: MonitoredProviderCapacitySessionDependencies,
    ) =>
      Effect.gen(function* () {
        const id = yield* Effect.sync(() => ++nextSessionId);
        const candidate = yield* transitionGate.withPermits(1)(
          Effect.gen(function* () {
            yield* closeSession(session);
            if (id !== nextSessionId) return undefined;

            yield* ensureUniqueProviderIds(dependencies.providers);
            const scope = yield* Scope.make();
            let installed = false;
            return yield* Effect.gen(function* () {
              if (id !== nextSessionId) return undefined;
              let mountedProviders: ReadonlyArray<MountedMonitoredProvider> =
                [];
              mountedProviders = yield* Effect.forEach(
                dependencies.providers,
                (provider) =>
                  mountMonitoredProvider(provider, (commit) =>
                    presentRoster(id, dependencies, mountedProviders, commit),
                  ).pipe(Effect.provideService(Scope.Scope, scope)),
                { concurrency: "unbounded" },
              );
              const monitors = mountedProviders.map(
                (provider) => provider.monitor,
              );
              if (id !== nextSessionId) return undefined;
              const created: Session = {
                id,
                scope,
                mountedProviders,
                monitors,
                monitorsByPiProviderId: new Map(
                  mountedProviders.map((provider) => [
                    provider.piProviderId,
                    provider.monitor,
                  ]),
                ),
              };
              session = created;
              installed = true;
              return created;
            }).pipe(
              Effect.ensuring(
                Effect.suspend(() =>
                  installed ? Effect.void : Scope.close(scope, Exit.void),
                ),
              ),
            );
          }),
        );
        if (candidate === undefined) return;
        yield* runInSessionScope(
          candidate,
          Effect.gen(function* () {
            yield* presentRoster(
              candidate.id,
              dependencies,
              candidate.mountedProviders,
            );
            if (session !== candidate) return;
            yield* Effect.all(
              candidate.mountedProviders.map((provider) => provider.activate),
              { concurrency: "unbounded" },
            );
            yield* Effect.all(
              candidate.monitors.map((monitor) =>
                monitor.start.pipe(Effect.catchAllCause(() => Effect.void)),
              ),
              { concurrency: "unbounded" },
            );
          }),
        );
      });

    const withCurrentSession = (
      operation: (candidate: Session) => Effect.Effect<void>,
    ) =>
      Effect.suspend(() => {
        const candidate = session;
        return candidate === undefined
          ? Effect.void
          : runInSessionScope(candidate, operation(candidate));
      });

    const withProviderMonitor = (
      piProviderId: string,
      operation: (monitor: ProviderMonitor) => Effect.Effect<void>,
    ) =>
      withCurrentSession((candidate) => {
        const monitor = candidate.monitorsByPiProviderId.get(piProviderId);
        return monitor === undefined ? Effect.void : operation(monitor);
      });

    return {
      start,
      observeResponse: (piProviderId, responseHeaders) =>
        withProviderMonitor(piProviderId, (monitor) =>
          monitor.observeResponse(responseHeaders),
        ),
      refreshAfterActivity: (piProviderId) =>
        withProviderMonitor(
          piProviderId,
          (monitor) => monitor.refreshAfterActivity,
        ),
      refreshForAccountChange: withCurrentSession((candidate) =>
        Effect.all(
          candidate.monitors.map((monitor) =>
            monitor.refreshForAccountChange.pipe(
              Effect.catchAllCause(() => Effect.void),
            ),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.asVoid),
      ),
      shutdown: Effect.gen(function* () {
        yield* Effect.sync(() => {
          nextSessionId += 1;
        });
        yield* transitionGate.withPermits(1)(closeSession(session));
      }),
    } satisfies MonitoredProviderCapacitySession;
  });
}
