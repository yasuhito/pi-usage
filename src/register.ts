import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";

import type { MonitoredProvider } from "./monitored-provider.ts";
import { makeMonitoredProviderCapacitySession } from "./monitored-provider-capacity-session.ts";

const STATUS_KEY = "pi-usage";

export type MonitoredProviderFactory = (
  ctx: ExtensionContext,
) => MonitoredProvider;

export interface MonitoredProviderCapacityDependencies {
  readonly providers: ReadonlyArray<MonitoredProviderFactory>;
  readonly now?: Effect.Effect<number>;
}

export function registerMonitoredProviderCapacity(
  pi: ExtensionAPI,
  dependencies: MonitoredProviderCapacityDependencies,
): void {
  const session = Effect.runSync(makeMonitoredProviderCapacitySession());
  const now = dependencies.now ?? Clock.currentTimeMillis;
  const run = (effect: Effect.Effect<void>) => Effect.runPromise(effect);

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") {
      await run(session.shutdown);
      return;
    }
    let lastRendered: string | undefined;
    await run(
      session.start({
        now,
        present: (presentations) =>
          Effect.sync(() => {
            const rendered = presentations
              .map(
                (presentation) =>
                  `${ctx.ui.theme.fg("accent", presentation.providerName)} ${ctx.ui.theme.fg(presentation.color, presentation.detail)}`,
              )
              .join(" ");
            if (rendered === lastRendered) return;
            lastRendered = rendered;
            ctx.ui.setStatus(STATUS_KEY, rendered);
          }),
        providers: dependencies.providers.map((makeProvider) =>
          makeProvider(ctx),
        ),
      }),
    );
  });

  pi.on("after_provider_response", async (event, ctx) => {
    const piProviderId = ctx.model?.provider;
    if (ctx.mode !== "tui" || piProviderId === undefined) return;
    await run(session.observeResponse(piProviderId, event.headers));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const piProviderId = ctx.model?.provider;
    if (ctx.mode !== "tui" || piProviderId === undefined) return;
    await run(session.refreshAfterActivity(piProviderId));
  });

  pi.on("model_select", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    await run(session.refreshForAccountChange);
  });

  pi.on("session_shutdown", async () => {
    await run(session.shutdown);
  });
}
