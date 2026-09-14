import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { test } from "vitest";

import { defineMonitoredProvider } from "../src/monitored-provider.ts";
import type {
  ProviderCapacityPresentation,
  WeeklySubscriptionProviderName,
  WeeklySubscriptionUsageStatus,
} from "../src/presentation.ts";
import { ProviderMonitorService } from "../src/provider-monitor.ts";
import {
  type MonitoredProviderFactory,
  registerMonitoredProviderCapacity,
} from "../src/register.ts";

type ExtensionHandler = (
  event: { readonly headers?: Readonly<Record<string, unknown>> },
  ctx: ExtensionContext,
) => void | Promise<void>;

interface ProviderProbe {
  readonly starts: number;
  readonly responses: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly activityRefreshes: number;
  readonly accountRefreshes: number;
  readonly finalizations: number;
}

function providerFactory(
  piProviderId: string,
  providerName: WeeklySubscriptionProviderName,
  usedPercent: number,
  probes: Map<string, ProviderProbe>,
): MonitoredProviderFactory {
  return () => {
    const providerProbeState = {
      starts: 0,
      responses: [] as Array<Readonly<Record<string, unknown>>>,
      activityRefreshes: 0,
      accountRefreshes: 0,
      finalizations: 0,
    };
    probes.set(piProviderId, providerProbeState);
    return defineMonitoredProvider<WeeklySubscriptionUsageStatus>({
      piProviderId,
      initialStatus: { kind: "loading" },
      makeMonitor: (publish) =>
        Layer.scoped(
          ProviderMonitorService,
          Effect.acquireRelease(
            Effect.succeed({
              start: Effect.sync(() => {
                providerProbeState.starts += 1;
              }).pipe(
                Effect.andThen(
                  publish({ kind: "available", usedPercent, stale: false }),
                ),
              ),
              observeResponse: (headers) =>
                Effect.sync(() => {
                  providerProbeState.responses.push(headers);
                }),
              refreshAfterActivity: Effect.sync(() => {
                providerProbeState.activityRefreshes += 1;
              }),
              refreshForAccountChange: Effect.sync(() => {
                providerProbeState.accountRefreshes += 1;
              }),
            }),
            () =>
              Effect.sync(() => {
                providerProbeState.finalizations += 1;
              }),
          ),
        ),
      present: (status): ProviderCapacityPresentation => ({
        providerName,
        detail:
          status.kind === "available"
            ? `${Math.round(status.usedPercent)}%`
            : status.kind,
        color:
          status.kind === "available" && status.usedPercent >= 75
            ? "warning"
            : "dim",
      }),
    });
  };
}

function registerFixture() {
  const handlers = new Map<string, ExtensionHandler[]>();
  const pi = {
    on(event: string, handler: ExtensionHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const probes = new Map<string, ProviderProbe>();
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  let mode: ExtensionContext["mode"] = "tui";
  let provider = "provider-a";
  let showThemeColors = false;

  registerMonitoredProviderCapacity(pi, {
    now: Effect.succeed(1_000_000),
    providers: [
      providerFactory("provider-a", "Codex", 63, probes),
      providerFactory("provider-b", "Claude", 80, probes),
    ],
  });

  const ctx = {
    get mode() {
      return mode;
    },
    get model() {
      return { provider };
    },
    ui: {
      theme: {
        fg: (color: string, text: string) =>
          showThemeColors ? `[${color}:${text}]` : text,
      },
      setStatus: (key: string, text: string | undefined) =>
        statuses.push({ key, text }),
    },
  } as unknown as ExtensionContext;
  const emit = async (event: string, payload: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(
        payload as { readonly headers?: Readonly<Record<string, unknown>> },
        ctx,
      );
    }
  };
  return {
    emit,
    probes,
    statuses,
    setMode: (value: ExtensionContext["mode"]) => {
      mode = value;
    },
    setProvider: (value: string) => {
      provider = value;
    },
    setShowThemeColors: (value: boolean) => {
      showThemeColors = value;
    },
  };
}

test("renders provider-independent registrations in roster order", async () => {
  const f = registerFixture();
  f.setShowThemeColors(true);

  await f.emit("session_start");

  assert.equal(
    f.statuses.at(-1)?.text,
    "[accent:Codex] [dim:63%] [accent:Claude] [warning:80%]",
  );
  assert.equal(f.probes.get("provider-a")?.starts, 1);
  assert.equal(f.probes.get("provider-b")?.starts, 1);
  await f.emit("session_shutdown");
});

test("routes response and activity events by Pi provider id", async () => {
  const f = registerFixture();
  await f.emit("session_start");

  await f.emit("after_provider_response", { headers: { observed: true } });
  await f.emit("agent_settled");

  assert.deepEqual(f.probes.get("provider-a")?.responses, [{ observed: true }]);
  assert.equal(f.probes.get("provider-a")?.activityRefreshes, 1);
  assert.deepEqual(f.probes.get("provider-b")?.responses, []);
  assert.equal(f.probes.get("provider-b")?.activityRefreshes, 0);
  await f.emit("session_shutdown");
});

test("refreshes every registration after model selection", async () => {
  const f = registerFixture();
  await f.emit("session_start");

  await f.emit("model_select");

  assert.equal(f.probes.get("provider-a")?.accountRefreshes, 1);
  assert.equal(f.probes.get("provider-b")?.accountRefreshes, 1);
  await f.emit("session_shutdown");
});

test("keeps non-TUI sessions inactive and closes a preceding TUI session", async () => {
  const f = registerFixture();
  await f.emit("session_start");
  const initialProviderAProbe = f.probes.get("provider-a");
  const initialProviderBProbe = f.probes.get("provider-b");

  f.setMode("rpc");
  await f.emit("session_start");
  f.setProvider("provider-b");
  await f.emit("after_provider_response", { headers: { ignored: true } });
  await f.emit("agent_settled");
  await f.emit("model_select");

  assert.equal(initialProviderAProbe?.finalizations, 1);
  assert.equal(initialProviderBProbe?.finalizations, 1);
  assert.deepEqual(initialProviderBProbe?.responses, []);
  assert.equal(initialProviderBProbe?.activityRefreshes, 0);
  assert.equal(initialProviderBProbe?.accountRefreshes, 0);
  assert.equal(f.statuses.length > 0, true);
  await f.emit("session_shutdown");
});
