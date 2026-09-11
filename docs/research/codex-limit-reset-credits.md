# Codex limit reset credits

**Research date:** 2026-09-11  
**Goal:** Determine how CodexBar and comparable Pi extensions obtain and present Codex limit reset credits.

## Finding

Limit reset credits are banked, consumable resets for Codex rate-limit windows. They are distinct from weekly quota percentages and paid extra-usage balances.

The existing account usage request already used by this extension can include a compact summary:

```http
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <Codex OAuth access token>
ChatGPT-Account-Id: <account/workspace ID>
```

```json
{
  "rate_limit_reset_credits": {
    "available_count": 2
  }
}
```

OpenAI's Codex backend client models the summary as `RateLimitResetCreditsSummary { available_count: i64 }`: [OpenAI Codex `types.rs`](https://github.com/openai/codex/blob/fc948f8c473e5d11e780ffcf1fd7f812a2020932/codex-rs/backend-client/src/types.rs).

For a compact footer count, reading `available_count` from the existing `/wham/usage` response avoids another authenticated request.

## How CodexBar obtains the detailed inventory

CodexBar additionally requests:

```http
GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits
Authorization: Bearer <Codex OAuth access token>
ChatGPT-Account-ID: <account/workspace ID>
Accept: application/json
OpenAI-Beta: codex-1
originator: Codex Desktop
User-Agent: CodexBar
```

The response contains `available_count` and a `credits` array with each credit's ID, status, grant time, and optional expiry. See CodexBar's [OAuth fetcher and decoder](https://github.com/steipete/CodexBar/blob/fe7a45ffab530e6b850800fd4a01ef1972709b0d/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift) and [credit model](https://github.com/steipete/CodexBar/blob/fe7a45ffab530e6b850800fd4a01ef1972709b0d/Sources/CodexBarCore/CreditsModels.swift).

CodexBar does not blindly display the response's summary count. It filters the inventory to credits whose status is `available` and whose expiry is absent or still in the future, sorts finite expiries earliest first, and displays the filtered length. Its compact menu row shows `N available` and up to four expiries; the CLI shows `Limit Reset Credits: N available`. Sources: [menu presentation](https://github.com/steipete/CodexBar/blob/fe7a45ffab530e6b850800fd4a01ef1972709b0d/Sources/CodexBar/MenuCardView%2BCodexResetCredits.swift), [CLI renderer](https://github.com/steipete/CodexBar/blob/fe7a45ffab530e6b850800fd4a01ef1972709b0d/Sources/CodexBarCLI/CLIRenderer.swift).

OpenAI's own client confirms both the detailed inventory endpoint and the alternate `/api/codex/rate-limit-reset-credits` path style: [OpenAI Codex reset-credit client](https://github.com/openai/codex/blob/fc948f8c473e5d11e780ffcf1fd7f812a2020932/codex-rs/backend-client/src/client/rate_limit_resets.rs).

## Comparable Pi extensions

- [`pi-usage-meters`](https://github.com/Quigleybits/pi-usage-meters/blob/83f8df3531285dd20894470fcbe495456639a18d/extensions/core.js#L338-L368) reads the summary from `/wham/usage`, then optionally fetches the detailed endpoint to show banked-reset dots and expiry dates.
- [`@debonzi/pi-codex-usage`](https://github.com/debonzi/ai-tools/blob/ed2cdd418a4198f29e8f66b1f9b9375faabf061c/packages/pi-codex-usage/agents/pi/extensions/codex-usage/core.ts) uses only the `/wham/usage` summary and renders a compact `resets N` suffix (and an applicable/usable count when supplied).
- [`pi-little-helpers`](https://github.com/tryingET/pi-extensions/blob/555fb3ab6ba51adfa3b837836e6c743dff57a0fa/packages/pi-little-helpers/lib/codex-reset.ts) fetches detailed inventory for `/codex-reset status` and also supports confirmed redemption. Redemption is outside this extension's display-only scope.

## Implementation decision

Use the optional `rate_limit_reset_credits.available_count` from the existing dedicated `/wham/usage` response and append the compact `· ↻N` indicator to the weekly meter. Show zero explicitly, omit the suffix when the field is absent or malformed, retain the last count across passive header-only weekly updates, and apply the weekly observation's existing stale/account lifecycle to the count.

This is intentionally a compact summary. A future expiry display would require the supplemental detailed request and CodexBar-style filtering. Like `/wham/usage`, these first-party ChatGPT endpoints are not documented as stable public OpenAI APIs, so parsing remains defensive.
