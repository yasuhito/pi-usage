import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect";

import type {
  ProviderCapacityPresentation,
  ProviderCapacityStatus,
} from "./presentation.ts";
import {
  type ProviderMonitor,
  ProviderMonitorService,
} from "./provider-monitor.ts";

export interface MonitoredProviderRegistration {
  readonly piProviderId: string;
  readonly makeLayer: (
    publish: (status: ProviderCapacityStatus) => Effect.Effect<void>,
  ) => Layer.Layer<ProviderMonitorService>;
  readonly present: (
    status: ProviderCapacityStatus,
    nowMs: number,
  ) => ProviderCapacityPresentation;
}

export function defineMonitoredProvider<
  Status extends ProviderCapacityStatus,
>(registration: {
  readonly piProviderId: string;
  readonly makeLayer: (
    publish: (status: Status) => Effect.Effect<void>,
  ) => Layer.Layer<ProviderMonitorService>;
  readonly present: (
    status: Status,
    nowMs: number,
  ) => ProviderCapacityPresentation;
}): MonitoredProviderRegistration {
  return {
    piProviderId: registration.piProviderId,
    makeLayer: (publish) => registration.makeLayer((status) => publish(status)),
    present: (status, nowMs) => registration.present(status as Status, nowMs),
  };
}

export interface PresentedProviderCapacity {
  readonly status: ProviderCapacityStatus;
  readonly presentation: ProviderCapacityPresentation;
}

export interface MonitoredProviderCapacitySessionDependencies {
  readonly providers: ReadonlyArray<MonitoredProviderRegistration>;
  readonly now: Effect.Effect<number>;
  readonly present: (
    capacities: ReadonlyArray<PresentedProviderCapacity>,
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
  readonly monitors: ReadonlyArray<ProviderMonitor>;
  readonly monitorsByPiProviderId: ReadonlyMap<string, ProviderMonitor>;
}

function ensureUniqueProviderIds(
  providers: ReadonlyArray<MonitoredProviderRegistration>,
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
              const capacities: ProviderCapacityStatus[] =
                dependencies.providers.map(() => ({ kind: "loading" }));
              const publish =
                (providerIndex: number) => (status: ProviderCapacityStatus) =>
                  Effect.gen(function* () {
                    if (session?.id !== id) return;
                    const now = yield* dependencies.now;
                    if (session?.id !== id) return;
                    if (capacities[providerIndex] === undefined) return;
                    capacities[providerIndex] = status;
                    yield* dependencies.present(
                      capacities.map((status, index) => {
                        const provider = dependencies.providers[index];
                        if (provider === undefined) {
                          throw new TypeError(
                            "provider roster changed during session",
                          );
                        }
                        return {
                          status,
                          presentation: provider.present(status, now),
                        };
                      }),
                    );
                  });
              const monitors = yield* Effect.forEach(
                dependencies.providers,
                (provider, index) =>
                  Layer.buildWithScope(
                    provider.makeLayer(publish(index)),
                    scope,
                  ).pipe(
                    Effect.map((services) =>
                      Context.get(services, ProviderMonitorService),
                    ),
                  ),
                { concurrency: "unbounded" },
              );
              if (id !== nextSessionId) return undefined;
              const created: Session = {
                id,
                scope,
                monitors,
                monitorsByPiProviderId: new Map(
                  dependencies.providers.map((provider, index) => [
                    provider.piProviderId,
                    monitors[index] as ProviderMonitor,
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
          Effect.all(
            candidate.monitors.map((monitor) =>
              monitor.start.pipe(Effect.catchAllCause(() => Effect.void)),
            ),
            { concurrency: "unbounded" },
          ).pipe(Effect.asVoid),
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
