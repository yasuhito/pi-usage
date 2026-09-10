# Codex weekly quota usage in Pi

**Research date:** 2026-09-10  
**Goal:** Persistently display the active `openai-codex` account’s weekly quota usage percentage in a Pi extension.

## Recommendation

Use a hybrid strategy with one authoritative source and one opportunistic source:

1. Resolve Pi’s active `openai-codex` OAuth credential with the documented `ctx.modelRegistry.getProviderAuth("openai-codex")` extension API.
2. Fetch the account-wide snapshot from OpenAI’s first-party Codex usage endpoint:

   ```http
   GET https://chatgpt.com/backend-api/wham/usage
   Authorization: Bearer <Pi-resolved-access-token>
   ChatGPT-Account-Id: <account id from token>
   ```

3. Opportunistically merge `x-codex-*` metadata observed through Pi’s documented `after_provider_response` event.
4. Identify the weekly window by its duration (`604800` seconds or `10080` minutes), not by assuming it is always the primary or secondary window.
5. Do not use Codex CLI `app-server`, local token totals, an artificial model request, or `~/.codex/auth.json` as the primary source.

The direct endpoint is used by OpenAI’s first-party Codex implementation, but is not a documented public OpenAI API. Parsing and failure handling must therefore be defensive.

## Pi package-gallery census

The Pi package gallery, npm metadata, linked repositories, and relevant source files were searched for Codex/OpenAI subscription usage, quota percentages, limit windows, and reset times. Most relevant extensions independently converge on the same ChatGPT usage endpoint.

### Direct or hybrid usage implementations

| Package | Role | Acquisition found in source |
| --- | --- | --- |
| [`@andre-barbosa/pi-codex-usage`](https://pi.dev/packages/@andre-barbosa/pi-codex-usage) | Footer | `/wham/usage` plus `x-codex-*` headers |
| [`@bacnh85/pi-sub`](https://pi.dev/packages/@bacnh85/pi-sub) | Subscription status | `/wham/usage` plus passive headers |
| [`@calesennett/pi-codex-usage`](https://pi.dev/packages/@calesennett/pi-codex-usage) | Footer | `/wham/usage` |
| [`@destiner/pi-usage`](https://pi.dev/packages/@destiner/pi-usage) | Multi-provider `/usage` | `/wham/usage` |
| [`@gowthamgts/pi-codex-usage`](https://pi.dev/packages/@gowthamgts/pi-codex-usage) | Footer | `/wham/usage`; Pi auth with Codex auth fallback |
| [`@hk_net/pi-usage-bars`](https://pi.dev/packages/@hk_net/pi-usage-bars) | Bars | `/wham/usage` |
| [`@janvitos/pi-usage`](https://pi.dev/packages/@janvitos/pi-usage) | Multi-provider usage | `/wham/usage` |
| [`@javargasm/pi-usage-bars`](https://pi.dev/packages/@javargasm/pi-usage-bars) | Footer and command | `/wham/usage` |
| [`@latentminds/pi-quotas`](https://pi.dev/packages/@latentminds/pi-quotas) | Multi-provider quota UI | `/wham/usage`; may inspect Codex auth for identity |
| [`@llblab/pi-codex-usage`](https://pi.dev/packages/@llblab/pi-codex-usage) | Minimal status | Pi-auth `/wham/usage`, app-server fallback |
| [`@monotykamary/pi-better-openai`](https://pi.dev/packages/@monotykamary/pi-better-openai) | Footer/OpenAI features | `/wham/usage` |
| [`@mtrojnar/pi-usage`](https://pi.dev/packages/@mtrojnar/pi-usage) | Widget and command | `/wham/usage`, passive headers, model-probe fallback |
| [`@narumitw/pi-codex-usage`](https://pi.dev/packages/@narumitw/pi-codex-usage) | Deprecated dedicated extension | `/wham/usage`, app-server fallback |
| [`@narumitw/pi-usage`](https://pi.dev/packages/@narumitw/pi-usage) | Multi-provider status | Pi-resolved auth and `/wham/usage` |
| [`@pi-plugins/usage`](https://pi.dev/packages/@pi-plugins/usage) | Command and widget | `/backend-api/wham/usage` |
| [`@pithos-kit/context-bar`](https://pi.dev/packages/@pithos-kit/context-bar) | Context/subscription bar | `/wham/usage` |
| [`@porche/pi-usage`](https://pi.dev/packages/@porche/pi-usage) | Limits and local history | `/wham/usage` for quota |
| [`@satas/pi-usage-bar`](https://pi.dev/packages/@satas/pi-usage-bar) | Footer gauge | `/wham/usage`; Codex and Pi auth support |
| [`@specode/pi-subscription-usage`](https://pi.dev/packages/@specode/pi-subscription-usage) | Quota command | `/wham/usage` |
| [`@spences10/pi-codex-usage`](https://pi.dev/packages/@spences10/pi-codex-usage) | Footer | `/wham/usage` plus headers |
| [`@sreetej510/pi-usage`](https://pi.dev/packages/@sreetej510/pi-usage) | Command/widget | Direct endpoint and app-server |
| [`@tian.zuo/pi-usage`](https://pi.dev/packages/@tian.zuo/pi-usage) | Usage/history | `/wham/usage`; separate local history |
| [`pi-ai-usage`](https://pi.dev/packages/pi-ai-usage) | Multi-provider monitor | ChatGPT usage endpoint |
| [`pi-better-openai`](https://pi.dev/packages/pi-better-openai) | Footer/OpenAI features | `/wham/usage` |
| [`pi-chatgpt-limit`](https://pi.dev/packages/pi-chatgpt-limit) | Footer | `/wham/usage`, Pi-resolved token |
| [`pi-cloud-quota`](https://pi.dev/packages/pi-cloud-quota) | Multi-provider bar | `/wham/usage`; reads Codex/Pi auth itself |
| [`pi-codex-account`](https://pi.dev/packages/pi-codex-account) | Account switching/usage | `/wham/usage` |
| [`pi-codex-footer`](https://pi.dev/packages/pi-codex-footer) | Two-line footer | Older `/backend-api/codex/usage` path |
| [`pi-codex-limit`](https://pi.dev/packages/pi-codex-limit) | Footer widget | `/wham/usage` |
| [`pi-codex-status`](https://pi.dev/packages/pi-codex-status) | CLI and extension | `/wham/usage`, headers, Codex rate-limit parser |
| [`pi-footer-template`](https://pi.dev/packages/pi-footer-template) | Configurable footer | `/wham/usage` among provider meters |
| [`pi-harness-runtime`](https://pi.dev/packages/pi-harness-runtime) | Harness quota view | `/wham/usage`; Codex auth integration |
| [`pi-openai-codex-status`](https://pi.dev/packages/pi-openai-codex-status) | Hourly/weekly status | `/wham/usage` |
| [`pi-openai-codex-usage`](https://pi.dev/packages/pi-openai-codex-usage) | Footer and command | `/wham/usage`, headers, reset-credit support |
| [`pi-provider-status`](https://pi.dev/packages/pi-provider-status) | Multi-provider status | `/wham/usage` plus headers |
| [`pi-sandbox-usage-status`](https://pi.dev/packages/pi-sandbox-usage-status) | Active-provider footer | `/wham/usage` |
| [`pi-seat`](https://pi.dev/packages/pi-seat) | Named account meters | `/wham/usage` per managed account |
| [`pi-usage-all`](https://pi.dev/packages/pi-usage-all) | All configured accounts | `/wham/usage` |
| [`pi-usage-bar-focus`](https://pi.dev/packages/pi-usage-bar-focus) | Footer gauge | `/wham/usage` |
| [`pi-usage-bars`](https://pi.dev/packages/pi-usage-bars) | Multi-provider bars | `/wham/usage` |
| [`pi-usage-limit-tracker`](https://pi.dev/packages/pi-usage-limit-tracker) | Pacing-aware footer | `/wham/usage` plus headers |
| [`pi-usage-meters`](https://pi.dev/packages/pi-usage-meters) | Usage meters | `/wham/usage` and reset-credit endpoint |
| [`@zaganjade/pi-usage`](https://pi.dev/packages/@zaganjade/pi-usage) | Attribution/history UI | Upstream quota plus local attribution |

Representative source implementations:

- [`@narumitw/pi-usage` Codex adapter](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-usage/src/providers/codex.ts)
- [`@narumitw/pi-usage` auth/query handling](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-usage/src/query.ts)
- [`@mtrojnar/pi-usage` Codex implementation](https://github.com/mtrojnar/pi-usage/blob/main/src/codex.ts)
- [`pi-openai-codex-usage`](https://github.com/frederick-wang/pi-openai-codex-usage/blob/main/extensions/openai-codex-usage.ts)
- [`pi-codex-status` rate-limit parser](https://github.com/lhl/pi-codex-status/blob/main/src/rate-limits.ts)
- [`@pi-plugins/usage` OpenAI provider](https://github.com/k3dom/pi-plugins/blob/main/plugins/usage/src/provider/openai.ts)

### App-server implementations

| Package | Method |
| --- | --- |
| [`pi-codex-usage`](https://pi.dev/packages/pi-codex-usage) | Spawns `codex app-server --listen stdio://`, then calls `account/rateLimits/read` |
| [`@llblab/pi-codex-usage`](https://pi.dev/packages/@llblab/pi-codex-usage) | App-server fallback |
| [`@sreetej510/pi-usage`](https://pi.dev/packages/@sreetej510/pi-usage) | App-server client |
| [`@narumitw/pi-codex-usage`](https://pi.dev/packages/@narumitw/pi-codex-usage) | App-server fallback |

Source example: [`pi-codex-usage`](https://github.com/avhagedorn/pi-codex-usage/blob/main/extensions/codex-usage.ts).

### Indirect proxy implementations

The following expose proxy-specific quotas and do not necessarily represent Pi’s built-in `openai-codex` account:

- [`pi-cliproxyapi-quota`](https://pi.dev/packages/pi-cliproxyapi-quota)
- [`cliproxy-usage`](https://pi.dev/packages/cliproxy-usage)
- [`pi-cliproxy-usage`](https://pi.dev/packages/pi-cliproxy-usage)
- [`pi-sub2api-provider`](https://pi.dev/packages/pi-sub2api-provider)

## Acquisition-method comparison

| Method | Account-wide | Other clients included | Extra quota cost | Main weakness |
| --- | ---: | ---: | ---: | --- |
| Authenticated `GET /backend-api/wham/usage` | Yes | Yes | None apparent | Undocumented public interface |
| Pi `after_provider_response` plus `x-codex-*` headers | Yes | Yes | None | Missing on some transports and unavailable at startup |
| Codex app-server `account/rateLimits/read` | Yes | Yes | None apparent | Requires Codex CLI and can use a different account |
| Artificial `POST /codex/responses` probe | Yes | Yes | Yes | Consumes allowance unnecessarily |
| Read `~/.codex/auth.json` and call endpoint | Yes | Yes | None | Can differ from Pi’s account and bypasses Pi auth lifecycle |
| Local session/token accounting | No | No | None | Cannot derive authoritative weighted quota |
| Proxy quota endpoint | Depends | Depends | None | May not represent the built-in provider |

## First-party endpoint

OpenAI’s Codex backend client chooses between two path styles:

- ChatGPT base URL containing `/backend-api`: `GET <base>/wham/usage`
- Codex API-style host: `GET <base>/api/codex/usage`

Sources:

- [`rate_limit_resets.rs`](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)
- [`PathStyle`](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs#L117-L132)
- [First-party app-server rate-limit tests](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/rate_limits.rs)

The backend response currently includes:

```text
rate_limit:
  primary_window:
    used_percent
    limit_window_seconds
    reset_after_seconds
    reset_at
  secondary_window:
    used_percent
    limit_window_seconds
    reset_after_seconds
    reset_at
additional_rate_limits[]
credits
rate_limit_reset_credits
spend_control
rate_limit_reached_type
```

The first-party representations are defined by:

- [`get_rate_limits_for_usage`](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)
- [`GetAccountRateLimitsResponse.json`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/GetAccountRateLimitsResponse.json)

Do not assume that `secondary_window` always means weekly. A seven-day window is identified by `limit_window_seconds = 604800` or `windowDurationMins = 10080`.

## Passive response headers

OpenAI’s Codex source parses:

```text
x-codex-primary-used-percent
x-codex-primary-window-minutes
x-codex-primary-reset-at
x-codex-secondary-used-percent
x-codex-secondary-window-minutes
x-codex-secondary-reset-at
x-codex-credits-has-credits
x-codex-credits-unlimited
x-codex-credits-balance
x-codex-rate-limit-reached-type
x-codex-promo-message
```

Canonical parser: [`openai/codex codex-api/src/rate_limits.rs`](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs).

Pi exposes response headers through its documented [`after_provider_response`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#after_provider_response) event. Header availability depends on provider and transport. WebSocket transport may not expose them, so this cannot be the only source. See [`pi-openai-codex-usage` ADR 0004](https://github.com/frederick-wang/pi-openai-codex-usage/blob/main/docs/adr/0004-passive-headers-opportunistic-merge.md).

## Codex app-server

The first-party app-server exposes `account/rateLimits/read` and sparse `account/rateLimits/updated` notifications:

- [`GetAccountRateLimitsResponse`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/GetAccountRateLimitsResponse.json)
- [`AccountRateLimitsUpdatedNotification`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/AccountRateLimitsUpdatedNotification.json)

Although first-party, this path requires a compatible `codex` executable and uses Codex CLI authentication, which may differ from Pi’s active account.

## Why local token accounting is insufficient

Pi session usage is useful for local history, but cannot produce authoritative subscription usage because:

- backend weighting can vary by model, reasoning level, caching, and service tier;
- it misses Codex CLI, cloud, IDE, and other Pi sessions;
- account limits do not expose one fixed public token denominator;
- accounts can contain multiple model-specific buckets.

Local calculations must be described as estimates, not quota truth.

## Pi authentication

Pi’s `openai-codex` provider uses ChatGPT OAuth. Extensions can resolve its current authentication with:

```ts
await ctx.modelRegistry.getProviderAuth("openai-codex");
```

Sources:

- [Pi `ctx.modelRegistry` documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#ctxmodelregistry--ctxmodel--ctxthinkinglevel--ctxscopedmodels)
- [Pi provider documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md#openai-codex)
- [Pi Codex OAuth account-ID extraction](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-codex.ts#L396-L415)
- [Pi Codex request headers](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-codex-responses.ts#L1596-L1614)

Pi sends the same ChatGPT OAuth identity to the Codex backend. OpenAI states that local messages and cloud chats share plan usage: [Codex pricing](https://developers.openai.com/codex/pricing/). It is therefore reasonable to infer that successful Pi `openai-codex` requests are included in the account-scoped usage response, although OpenAI does not explicitly guarantee Pi accounting as a separate public contract.

## Proposed lifecycle

- `session_start`: show loading state and fetch.
- `model_select`: clear when leaving `openai-codex`; fetch when entering it.
- While active: refresh every 60 seconds.
- `agent_settled`: debounce a refresh when the last successful fetch is older than 30–60 seconds.
- `after_provider_response`: merge recognized headers immediately.
- `session_shutdown`: abort requests and clear timers.

The first-party Codex TUI polling implementation is [`rate_limit_refresh_interval`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/rate_limits.rs#L189-L217). A fixed one-minute interval is more appropriate for a passive footer extension.

## Stale-data policy

- Keep the last good value on timeouts, `429`, or temporary `5xx` responses.
- Mark stale data, for example `Codex wk 63% ~`.
- Do not present an old value once its `reset_at` has passed.
- After about ten minutes without a successful fetch, display `Codex wk unavailable`.
- Honor `Retry-After` and use exponential backoff with jitter.
- On `401`/`403`, resolve Pi auth again once and retry.
- Discard snapshots when the account identity changes.
- Merge sparse headers without erasing fields absent from the headers.

## Security constraints

- Use a fixed allowlisted HTTPS origin.
- Set `redirect: "manual"` and reject redirects.
- Never log bearer tokens, JWTs, raw headers, auth resolver objects, or raw API payloads.
- Never write Pi or Codex auth files.
- Do not accept a project-configured usage endpoint.
- Apply request timeout, response-size limits, and field validation.
- Do not persist tokens, account IDs, raw headers, or raw responses.

If startup persistence is later needed, persist only normalized percentages, durations, reset timestamps, capture time, and a non-reversible account fingerprint.

## UI recommendation

Use Pi’s `ctx.ui.setStatus()` rather than replacing the footer:

```text
Codex wk 63%
Codex wk 63% · 2d 4h
Codex wk 63% ~
Codex wk unavailable
```

Always label the displayed number as **used**, not remaining.

## Interface stability

| Interface | Status |
| --- | --- |
| Pi `getProviderAuth`, lifecycle events, `after_provider_response`, `setStatus` | Documented Pi extension APIs |
| Codex app-server schemas and `account/rateLimits/read` | First-party source-defined, but version-sensitive |
| `x-codex-*` headers | First-party source-defined, not a public OpenAI API contract |
| `https://chatgpt.com/backend-api/wham/usage` | Used by first-party Codex, but undocumented as a supported public API |
| Backend payload fields | First-party and verifiable, without a public compatibility promise |
| Fixed “five-hour primary, weekly secondary” meaning | Unsafe assumption |

## Conclusion

The best first release is Pi-resolved OAuth plus `GET https://chatgpt.com/backend-api/wham/usage`, with `x-codex-*` header merging as an optimization. It provides account-wide accuracy, includes activity outside the current Pi process, requires no Codex CLI, works independently of model-request transport, and avoids consuming allowance. Its primary residual risk is the undocumented status of the first-party ChatGPT usage endpoint, which should be isolated behind a defensive adapter.
