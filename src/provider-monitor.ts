import { Context, type Effect } from "effect";

/** The complete session-scoped interface exposed to the Pi adapter. */
export interface ProviderMonitor {
  readonly start: Effect.Effect<void>;
  readonly observeResponse: (
    fields: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly refreshAfterActivity: Effect.Effect<void>;
  readonly refreshForAccountChange: Effect.Effect<void>;
}

export class ProviderMonitorService extends Context.Tag("ProviderMonitor")<
  ProviderMonitorService,
  ProviderMonitor
>() {}
