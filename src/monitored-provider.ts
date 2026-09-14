import { Context, Effect, Layer, type Scope } from "effect";

import type {
  ProviderCapacityPresentation,
  ProviderCapacityStatus,
} from "./presentation.ts";
import {
  type ProviderMonitor,
  ProviderMonitorService,
} from "./provider-monitor.ts";

const monitoredProviderBrand: unique symbol = Symbol("MonitoredProvider");

type MountMonitoredProvider = (
  statusChanged: (commit: Effect.Effect<void>) => Effect.Effect<void>,
) => Effect.Effect<MountedMonitoredProvider, never, Scope.Scope>;

const mounts = new WeakMap<MonitoredProvider, MountMonitoredProvider>();

/** @internal A session-owned view of one mounted monitored provider. */
export interface MountedMonitoredProvider {
  readonly piProviderId: string;
  readonly monitor: ProviderMonitor;
  readonly activate: Effect.Effect<void>;
  readonly present: (nowMs: number) => ProviderCapacityPresentation;
}

export interface MonitoredProvider {
  readonly piProviderId: string;
  readonly [monitoredProviderBrand]: true;
}

/**
 * Keeps one monitored provider's status and presentation interpretation behind
 * an opaque, type-safe seam.
 */
export function defineMonitoredProvider<
  Status extends ProviderCapacityStatus,
>(definition: {
  readonly piProviderId: string;
  readonly initialStatus: Extract<Status, { readonly kind: "loading" }>;
  readonly makeMonitor: (
    publish: (status: Status) => Effect.Effect<void>,
  ) => Layer.Layer<ProviderMonitorService>;
  readonly present: (
    status: Status,
    nowMs: number,
  ) => ProviderCapacityPresentation;
}): MonitoredProvider {
  const provider: MonitoredProvider = {
    piProviderId: definition.piProviderId,
    [monitoredProviderBrand]: true,
  };
  mounts.set(provider, (statusChanged) =>
    Effect.gen(function* () {
      let active = false;
      let status: Status = definition.initialStatus;
      const services = yield* Layer.build(
        definition.makeMonitor((nextStatus) =>
          Effect.suspend(() =>
            active
              ? statusChanged(
                  Effect.sync(() => {
                    status = nextStatus;
                  }),
                )
              : Effect.void,
          ),
        ),
      );
      return {
        piProviderId: definition.piProviderId,
        monitor: Context.get(services, ProviderMonitorService),
        activate: Effect.sync(() => {
          active = true;
        }),
        present: (nowMs) => definition.present(status, nowMs),
      };
    }),
  );
  return provider;
}

/** @internal Installs an opaque monitored provider in its session Scope. */
export function mountMonitoredProvider(
  provider: MonitoredProvider,
  statusChanged: (commit: Effect.Effect<void>) => Effect.Effect<void>,
): Effect.Effect<MountedMonitoredProvider, never, Scope.Scope> {
  const mount = mounts.get(provider);
  return mount === undefined
    ? Effect.die(new TypeError("invalid monitored provider"))
    : mount(statusChanged);
}
