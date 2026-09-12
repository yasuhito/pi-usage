# Claude and OpenRouter usage data in Pi

**Research date:** 2026-09-12  
**Goal:** Determine which usage, quota, and reset information a Pi extension can obtain for Anthropic/Claude and OpenRouter, and which Pi authentication routes are available.

## Recommendation

Treat Claude and OpenRouter as different quota domains rather than forcing both into the existing Codex weekly-quota model.

- **Anthropic API-key accounts:** opportunistically observe documented API rate-limit response headers. Organization-wide historical usage, cost, and configured limits require an Admin credential that Pi does not normally provide.
- **Claude Pro/Max subscriptions:** do not promise a supported weekly-quota meter. Claude Code can expose subscription rate-limit percentages to its own status line, but Anthropic does not document a general-purpose subscription-usage API for third-party extensions. Pi also states that its third-party Anthropic harness usage draws from paid extra usage rather than Claude plan limits.
- **OpenRouter:** query the documented `GET /api/v1/key` endpoint with Pi's resolved OpenRouter API key. This provides per-key spend limits, remaining spend, reset configuration, and usage aggregates. Do not present these as subscription weekly quota.
- Resolve all credentials through Pi's documented `ctx.modelRegistry.getProviderAuth(providerId)` interface. Do not read Pi credential files directly.

## Capability summary

| Provider/account kind | Supported data available to the extension | Scope | Main limitation |
| --- | --- | --- | --- |
| Anthropic ordinary API key | Live request/token capacity from inference response headers | Active API request and applicable rate-limit bucket | No dedicated endpoint for live remaining capacity |
| Anthropic Admin credential | Historical token usage, cost, and configured organization/workspace limits | Organization or workspace | Requires privileged Admin auth, not an ordinary inference key |
| Claude Pro/Max subscription | No supported general-purpose query identified | — | Claude Code's subscription usage surface is not a public third-party API |
| OpenRouter ordinary API key | Per-key limit, remaining limit, reset interval, expiration, and usage aggregates from `/api/v1/key`; per-response token/cost usage | Authenticated key | Does not reveal account-wide purchased-credit balance |
| OpenRouter management key | Account credits, cross-key management and analytics | User/account or workspace | Separate privileged key; cannot make inference requests |

## Anthropic API usage and limits

### Historical usage and configured limits

Anthropic documents the following administrative interfaces:

- `GET /v1/organizations/usage_report/messages` returns bucketed Messages API usage, including input, output, cache, and server-tool token counts. It supports grouping and filtering dimensions such as model, API key, workspace, service tier, and context window.
- `GET /v1/organizations/cost_report` returns daily cost records.
- `GET /v1/organizations/rate_limits` returns configured organization rate-limit groups.
- `GET /v1/organizations/workspaces/{workspace_id}/rate_limits` returns workspace overrides.

The usage and cost data normally becomes available within about five minutes, and Anthropic documents sustained polling at no more than once per minute. These are reporting/configuration interfaces, not a live remaining-capacity meter.

Sources:

- [Anthropic Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)
- [Anthropic Rate Limits API](https://platform.claude.com/docs/en/manage-claude/rate-limits-api)
- [List organization rate limits](https://platform.claude.com/docs/en/api/admin/rate_limits/list)

These administrative interfaces require an Admin API key or appropriately scoped organization OAuth credential. An ordinary workspace inference key is insufficient. Their organization-wide visibility makes them inappropriate to request implicitly from a footer extension.

Source: [Anthropic Admin API authentication](https://platform.claude.com/docs/en/api/admin)

### Live API rate-limit state

Anthropic inference responses document request and token rate-limit headers, including:

```text
anthropic-ratelimit-requests-limit
anthropic-ratelimit-requests-remaining
anthropic-ratelimit-requests-reset
anthropic-ratelimit-tokens-limit
anthropic-ratelimit-tokens-remaining
anthropic-ratelimit-tokens-reset
anthropic-ratelimit-input-tokens-*
anthropic-ratelimit-output-tokens-*
retry-after
```

Reset values are RFC 3339 timestamps. Anthropic rate limits use a token-bucket algorithm and continuously replenish up to the documented limit, so the reset value is not equivalent to a fixed weekly subscription reset. The configured Rate Limits API does not return these live remaining counters.

Source: [Anthropic API rate limits and response headers](https://platform.claude.com/docs/en/api/rate-limits)

A Pi extension can consume these headers opportunistically from `after_provider_response`, subject to transport/header availability. It should not issue a paid artificial model request solely to obtain them.

### Monthly spend caps

Anthropic API organizations can have monthly spend caps. When reached, API usage is rejected until the first day of the next month at 00:00 UTC. The documented Usage and Cost API can report incurred cost, but it is delayed reporting rather than an authoritative remaining-balance field.

Source: [Anthropic spend limits](https://platform.claude.com/docs/en/api/rate-limits#spend-limits)

## Claude subscription usage

Claude Code documents a `rate_limits` object for status-line input. Applicable subscriber accounts may receive independent five-hour and seven-day windows:

```json
{
  "rate_limits": {
    "five_hour": {
      "used_percentage": 23.5,
      "resets_at": 1738425600
    },
    "seven_day": {
      "used_percentage": 41.2,
      "resets_at": 1738857600
    }
  }
}
```

The fields are usage percentages and Unix reset timestamps. They may be absent until Claude Code receives an API response, and each window can be absent independently.

Source: [Claude Code status-line data](https://code.claude.com/docs/en/statusline#available-data)

This is a documented **Claude Code status-line surface**, not a documented web API for arbitrary clients. Anthropic's first-party Claude Code distribution currently calls an internal OAuth usage endpoint, but that endpoint is absent from the public Anthropic API reference and has no third-party compatibility guarantee. It must not be treated as a stable provider interface.

Pi additionally documents that Anthropic subscription authentication is available for Claude Pro/Max accounts, but that third-party harness traffic draws from **paid extra usage**, not Claude plan limits.

Source: [Pi providers: Anthropic subscription auth](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md#anthropic)

Therefore the supported initial behavior for Pi is:

- do not label Anthropic API rate limits as Claude weekly subscription usage;
- do not promise Pro/Max weekly quota acquisition;
- if experimental internal-endpoint support is ever considered, isolate it behind a separate adapter, feature flag it, verify OAuth scopes, and describe its unsupported status in the UI and documentation.

## OpenRouter usage, limits, and resets

### Current-key endpoint

An ordinary OpenRouter inference key can authenticate:

```http
GET https://openrouter.ai/api/v1/key
Authorization: Bearer <OpenRouter API key>
```

The documented response describes the authenticated key and includes:

- optional USD `limit` and `limit_remaining`;
- `limit_reset`, which can be `daily`, `weekly`, `monthly`, or `null`;
- all-time, daily, weekly, and monthly usage;
- corresponding BYOK usage;
- whether BYOK usage is included in the key limit;
- expiration, key type, and free-tier status.

The legacy `rate_limit` field is deprecated and always returns `-1`, so it must not be used.

Sources:

- [OpenRouter: get current API key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)
- [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits)

The limit and remaining amount are **per key**, not an account-wide purchased-credit balance. A `null` limit means that the key has no configured spending cap. Daily limits reset at midnight UTC, weekly limits follow Monday–Sunday UTC, and monthly limits follow the UTC calendar month.

For this project, `/api/v1/key` is the best supported dedicated acquisition endpoint. Poll conservatively, cache results, back off on failures, and prefer refresh after relevant activity rather than frequent unconditional polling. OpenRouter does not document a polling freshness SLA for this endpoint.

### Per-request usage

OpenRouter inference responses contain a `usage` object with token counts and charged cost. Non-streaming responses include it directly; streaming responses include it in the final chunk. This is useful for immediate request attribution but is not itself a quota or account-balance response.

Source: [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)

### Account credits and management APIs

`GET /api/v1/credits` returns `total_credits` and `total_usage` for the account. It requires a separate management key. The response has no explicit remaining field; a presentation may derive `total_credits - total_usage` while retaining the original values and currency semantics.

Management keys can also list/manage keys and access account analytics, but cannot be used for inference. They have broader account visibility and should be explicit opt-in configuration rather than inferred from Pi's normal OpenRouter model credential.

Sources:

- [OpenRouter credits endpoint](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)
- [OpenRouter management API keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)

### Request-rate limits

The current-key endpoint's `rate_limit` field is deprecated, and successful inference responses do not provide a proactive platform request-quota counter. OpenRouter documents `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` when its own platform returns a `429`; `Retry-After` may also be supplied. Provider-originated limits must be distinguished from OpenRouter platform limits where response metadata allows it.

Source: [OpenRouter API credit and rate limits](https://openrouter.ai/docs/api_reference/limits)

Do not synthesize a precise free-model daily-reset countdown unless the provider supplies an unambiguous reset value at runtime.

## Pi authentication routes

Pi 0.85.1 documents provider-level auth resolution through:

```ts
const result = await ctx.modelRegistry.getProviderAuth(providerId);
```

This resolves authentication without requiring an active model and returns normalized request auth, potentially including `apiKey`, `headers`, `baseUrl`, provider-scoped environment, and a source description. It can return `undefined` for unknown/unconfigured providers and can reject when credential resolution or OAuth refresh fails.

Sources:

- [Pi extension context and model registry](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#ctxmodelregistry--ctxmodel--ctxthinkinglevel--ctxscopedmodels)
- Installed type: `node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts`
- Installed implementation: `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js`

### Provider IDs

| Provider | Pi provider ID | Default base URL |
| --- | --- | --- |
| Direct Anthropic | `anthropic` | `https://api.anthropic.com` |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` |

Sources:

- `node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js`
- `node_modules/@earendil-works/pi-ai/dist/providers/openrouter.js`

A Claude model routed through OpenRouter still uses provider ID `openrouter`; model-vendor prefixes must not be used as the authentication provider.

### Anthropic auth shape

Depending on configuration, Pi may resolve Anthropic authentication as an API key or an `Authorization` header. Stored Claude subscription OAuth is refreshed by Pi and exposed through the normalized auth result. An extension must not blindly send every `apiKey` value as `x-api-key`: endpoint-specific credential handling is required, and it must avoid sending both API-key and bearer mechanisms.

Relevant installed first-party source:

- `node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js`
- `node_modules/@earendil-works/pi-ai/dist/auth/oauth/anthropic.js`
- `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`

### OpenRouter auth shape

Pi resolves both configured OpenRouter API keys and keys obtained through OpenRouter's OAuth PKCE flow as `auth.apiKey`. The provider ID is `openrouter`.

Sources:

- [Pi providers: OpenRouter](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md#openrouter)
- [OpenRouter OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)
- `node_modules/@earendil-works/pi-ai/dist/auth/oauth/openrouter.js`

### Lifecycle and security

- Resolve credentials at acquisition time so OAuth refresh, logout, and account replacement can be observed.
- Use `event.model.provider` on `model_select`; do not infer the provider from the model ID.
- `after_provider_response` can provide passive response headers for the active request, but header availability depends on provider and transport.
- Pi does not document a general auth-changed extension event, so model-selection events alone cannot detect every login/logout change.
- Pi extensions are not sandboxed. Never log, persist, render, or attach resolved secrets to errors.
- Send credentials only to fixed allowlisted HTTPS origins, reject redirects, and retain the project's existing timeout, response-size, and payload-validation protections.
- Do not read `~/.pi/agent/auth.json`; doing so bypasses Pi's precedence rules and OAuth refresh lifecycle and exposes refresh credentials unnecessarily.

Sources:

- [Pi extension lifecycle and security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi provider authentication](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)

## Design consequences

The existing `WeeklyQuotaUsage` type cannot represent all three providers faithfully:

- Codex exposes provider-reported subscription-window utilization.
- Anthropic API headers expose continuously replenishing request/token buckets, while its Admin APIs expose delayed organization usage and configured limits.
- OpenRouter exposes monetary key limits and usage aggregates, with optional daily/weekly/monthly reset policies.

The implementation should therefore place provider-specific adapters behind a higher-level usage-status interface without normalizing unlike quantities into one percentage. At minimum, preserve:

- metric kind: subscription utilization, monetary spend, token/request capacity, or historical usage;
- scope: account, organization, workspace, or API key;
- window/reset semantics;
- source stability: documented public interface versus experimental internal interface;
- freshness and acquisition timestamp.

## Conclusion

OpenRouter has a practical, documented path for a Pi extension: resolve `openrouter` auth and query `/api/v1/key` for per-key spend usage and reset configuration. Anthropic has documented paths for API rate-limit headers and privileged organization reporting, but no supported third-party equivalent of the existing Codex weekly subscription meter. Multi-provider support should expose these semantic differences instead of presenting all providers as interchangeable weekly quota percentages.
