import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Clock, Context, Effect, Exit, Layer, Scope } from "effect";
import {
  type CodexCredentialResolution,
  codexProviderMonitorLayer,
} from "./codex-provider-monitor.ts";
import type {
  AcquireDedicatedWeeklyQuotaUsage,
  CodexCredential,
} from "./dedicated-weekly-quota-acquisition.ts";
import { presentQuotaStatus } from "./presentation.ts";
import {
  type ProviderMonitor,
  ProviderMonitorService,
} from "./provider-monitor.ts";

const STATUS_KEY = "pi-usage";

export interface WeeklyQuotaUsageDependencies {
  readonly acquireDedicatedWeeklyQuotaUsage: AcquireDedicatedWeeklyQuotaUsage;
  readonly now?: Effect.Effect<number>;
  readonly random?: Effect.Effect<number>;
}

function accountIdFromAccessToken(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const openAiAuth =
      typeof claims === "object" && claims !== null
        ? Reflect.get(claims, "https://api.openai.com/auth")
        : undefined;
    const accountId =
      typeof openAiAuth === "object" && openAiAuth !== null
        ? Reflect.get(openAiAuth, "chatgpt_account_id")
        : undefined;
    return typeof accountId === "string" && accountId.trim() !== ""
      ? accountId
      : undefined;
  } catch {
    return undefined;
  }
}

function credentialFromContext(
  auth: Awaited<
    ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>
  >,
): CodexCredential | undefined {
  const accessToken = auth?.auth.apiKey;
  const headers = auth?.auth.headers;
  const accountIdEntry = headers
    ? Object.entries(headers).find(
        ([name]) => name.toLowerCase() === "chatgpt-account-id",
      )
    : undefined;
  if (typeof accessToken !== "string" || accessToken.trim() === "")
    return undefined;
  const headerAccountId = accountIdEntry?.[1];
  const accountId =
    typeof headerAccountId === "string" && headerAccountId.trim() !== ""
      ? headerAccountId
      : accountIdFromAccessToken(accessToken);
  return accountId === undefined ? undefined : { accessToken, accountId };
}

function credentialResolution(ctx: ExtensionContext) {
  return Effect.tryPromise(() =>
    ctx.modelRegistry.getProviderAuth("openai-codex"),
  ).pipe(
    Effect.map((auth): CodexCredentialResolution => {
      if (auth === undefined) return { kind: "missing" };
      const credential = credentialFromContext(auth);
      return credential === undefined
        ? { kind: "invalid" }
        : { kind: "available", credential };
    }),
    Effect.catchAll(() => Effect.succeed({ kind: "invalid" } as const)),
  );
}

interface Session {
  readonly id: number;
  readonly scope: Scope.CloseableScope;
  readonly monitor: ProviderMonitor;
}

export function registerWeeklyQuotaUsage(
  pi: ExtensionAPI,
  dependencies: WeeklyQuotaUsageDependencies,
): void {
  let session: Session | undefined;
  let nextSessionId = 0;
  const now = dependencies.now ?? Clock.currentTimeMillis;

  const closeSession = async (
    candidate: Session | undefined,
  ): Promise<void> => {
    if (candidate === undefined) return;
    await Effect.runPromise(Scope.close(candidate.scope, Exit.void));
    if (session === candidate) session = undefined;
  };

  const run = async (candidate: Session, effect: Effect.Effect<void>) => {
    if (session !== candidate) return;
    await Effect.runPromise(
      effect.pipe(
        Effect.catchAllCause(() => Effect.void),
        Effect.provideService(Scope.Scope, candidate.scope),
      ),
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    const id = ++nextSessionId;
    await closeSession(session);
    if (id !== nextSessionId || ctx.mode !== "tui") return;

    const scope = await Effect.runPromise(Scope.make());
    if (id !== nextSessionId) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      return;
    }
    const services = await Effect.runPromise(
      Layer.buildWithScope(
        codexProviderMonitorLayer({
          resolveCredential: credentialResolution(ctx),
          acquireDedicatedWeeklyQuotaUsage:
            dependencies.acquireDedicatedWeeklyQuotaUsage,
          ...(dependencies.random === undefined
            ? {}
            : { random: dependencies.random }),
          publish: (status) =>
            Effect.gen(function* () {
              if (session?.id !== id) return;
              if (status === undefined) {
                ctx.ui.setStatus(STATUS_KEY, undefined);
                return;
              }
              const currentTime = yield* now;
              const presentation = presentQuotaStatus(status, currentTime);
              ctx.ui.setStatus(
                STATUS_KEY,
                ctx.ui.theme.fg(presentation.color, presentation.text),
              );
            }),
        }),
        scope,
      ),
    );
    const monitor = Context.get(services, ProviderMonitorService);
    if (id !== nextSessionId) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      return;
    }
    const candidate = { id, scope, monitor };
    session = candidate;
    await run(candidate, monitor.start);
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (ctx.mode !== "tui" || ctx.model?.provider !== "openai-codex") return;
    const candidate = session;
    if (candidate !== undefined) {
      await run(candidate, candidate.monitor.observeResponse(event.headers));
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const candidate = session;
    if (candidate !== undefined)
      await run(candidate, candidate.monitor.refreshAfterActivity);
  });

  pi.on("model_select", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const candidate = session;
    if (candidate !== undefined)
      await run(candidate, candidate.monitor.refreshForAccountChange);
  });

  pi.on("session_shutdown", async () => {
    nextSessionId += 1;
    await closeSession(session);
  });
}
