import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect";

import {
  type ClaudeProviderMonitorDependencies,
  ClaudeProviderMonitorService,
  claudeProviderMonitorLayer,
} from "./claude-provider-monitor.ts";
import {
  type CodexProviderMonitorDependencies,
  codexProviderMonitorLayer,
} from "./codex-provider-monitor.ts";
import type {
  MonitoredProviderName,
  WeeklySubscriptionUsageStatus,
} from "./presentation.ts";
import {
  type ProviderMonitor,
  ProviderMonitorService,
} from "./provider-monitor.ts";

export interface WeeklySubscriptionUsageLifecycleSessionDependencies {
  readonly codex: Omit<CodexProviderMonitorDependencies, "publish">;
  readonly makeClaudeDependencies: () => Omit<
    ClaudeProviderMonitorDependencies,
    "publish"
  >;
  readonly now: Effect.Effect<number>;
  readonly present: (
    statuses: Readonly<
      Record<MonitoredProviderName, WeeklySubscriptionUsageStatus>
    >,
    nowMs: number,
  ) => Effect.Effect<void>;
}

export interface WeeklySubscriptionUsageLifecycle {
  readonly start: (
    dependencies: WeeklySubscriptionUsageLifecycleSessionDependencies,
  ) => Effect.Effect<void>;
  readonly observeCodexResponse: (
    responseHeaders: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly refreshAfterActivity: (
    providerName: MonitoredProviderName,
  ) => Effect.Effect<void>;
  readonly refreshForAccountChange: Effect.Effect<void>;
  readonly shutdown: Effect.Effect<void>;
}

interface Session {
  readonly id: number;
  readonly scope: Scope.CloseableScope;
  readonly codexMonitor: ProviderMonitor;
  readonly claudeMonitor: ProviderMonitor;
}

/** Owns replacement, scoped monitor lifetime, and suppression of late work. */
export function makeWeeklySubscriptionUsageLifecycle(): Effect.Effect<WeeklySubscriptionUsageLifecycle> {
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
      dependencies: WeeklySubscriptionUsageLifecycleSessionDependencies,
    ) =>
      Effect.gen(function* () {
        const id = yield* Effect.sync(() => ++nextSessionId);
        const candidate = yield* transitionGate.withPermits(1)(
          Effect.gen(function* () {
            yield* closeSession(session);
            if (id !== nextSessionId) return undefined;

            const scope = yield* Scope.make();
            let installed = false;
            return yield* Effect.gen(function* () {
              if (id !== nextSessionId) return undefined;
              const statuses: Record<
                MonitoredProviderName,
                WeeklySubscriptionUsageStatus
              > = {
                Codex: { kind: "loading" },
                Claude: { kind: "loading" },
              };
              const publish =
                (providerName: MonitoredProviderName) =>
                (status: WeeklySubscriptionUsageStatus) =>
                  Effect.gen(function* () {
                    if (session?.id !== id) return;
                    const now = yield* dependencies.now;
                    if (session?.id !== id) return;
                    statuses[providerName] = status;
                    yield* dependencies.present(statuses, now);
                  });
              const monitorLayers = Layer.merge(
                codexProviderMonitorLayer({
                  ...dependencies.codex,
                  publish: publish("Codex"),
                }),
                claudeProviderMonitorLayer({
                  ...dependencies.makeClaudeDependencies(),
                  publish: publish("Claude"),
                }),
              );
              const services = yield* Layer.buildWithScope(
                monitorLayers,
                scope,
              );
              if (id !== nextSessionId) return undefined;
              const created = {
                id,
                scope,
                codexMonitor: Context.get(services, ProviderMonitorService),
                claudeMonitor: Context.get(
                  services,
                  ClaudeProviderMonitorService,
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
            [candidate.codexMonitor.start, candidate.claudeMonitor.start],
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

    return {
      start,
      observeCodexResponse: (responseHeaders) =>
        withCurrentSession((candidate) =>
          candidate.codexMonitor.observeResponse(responseHeaders),
        ),
      refreshAfterActivity: (providerName) =>
        withCurrentSession((candidate) =>
          providerName === "Codex"
            ? candidate.codexMonitor.refreshAfterActivity
            : candidate.claudeMonitor.refreshAfterActivity,
        ),
      refreshForAccountChange: withCurrentSession((candidate) =>
        Effect.all(
          [
            candidate.codexMonitor.refreshForAccountChange,
            candidate.claudeMonitor.refreshForAccountChange,
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.asVoid),
      ),
      shutdown: Effect.gen(function* () {
        yield* Effect.sync(() => {
          nextSessionId += 1;
        });
        yield* transitionGate.withPermits(1)(closeSession(session));
      }),
    } satisfies WeeklySubscriptionUsageLifecycle;
  });
}
