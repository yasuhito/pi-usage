# Pi Usage

Pi Usage presents provider-reported subscription capacity so users can judge their remaining ability to work across AI coding tools.

## Language

**Weekly subscription usage**:
A provider-reported consumed percentage and reset time for a subscription allowance whose window lasts seven days. It is the common presentable concept shared by Codex weekly quota usage and Claude's seven-day subscription usage; provider-specific calculation and supplemental fields remain distinct.
_Avoid_: Provider usage, API rate limit, weekly token usage

**Weekly quota usage**:
The Codex-provider-reported percentage of an account’s weighted weekly allowance that has been consumed. It is not calculated from a fixed token denominator.
_Avoid_: Weekly subscription usage, weekly token usage, weekly token limit

**Weekly window**:
A provider-reported subscription allowance window whose duration is exactly seven days. Provider-specific position or name alone does not identify it.
_Avoid_: Secondary window

**Stale usage**:
The last successfully observed weekly subscription usage when a newer observation temporarily cannot be obtained. It remains presentable for at most ten minutes and never beyond its reported reset time.
_Avoid_: Cached usage, current usage

**Claude subscription usage**:
The provider-reported utilization of a Claude Pro or Max account's rolling usage windows, including five-hour and seven-day windows when available. It is distinct from Anthropic API-key rate limits and organization billing usage.
_Avoid_: Anthropic API usage, Claude API rate limit

**Monitored provider**:
A provider the user expects Pi Usage to observe and present. A monitored provider remains presentable as unavailable when its credential is missing or its usage cannot be acquired; a provider that is not monitored is omitted entirely.
_Avoid_: Configured provider, enabled provider

**Weekly reset countdown**:
The compact remaining time until the provider-reported weekly window reset. It is derived from the weekly window's reset timestamp and shown separately from the available limit reset credit count.
_Avoid_: Credit expiry, reset credit countdown

**Limit reset credit**:
A provider-granted, consumable credit that resets a Codex rate-limit window. It is separate from weekly quota usage and paid extra-usage balances. The footer reports the provider's available count.
_Avoid_: Weekly credit, usage credit

**Weekly subscription usage lifecycle**:
The progression of a provider's weekly subscription usage from initial acquisition through fresh observation, temporary staleness, expiration, and session end. Each monitored provider progresses independently.
_Avoid_: Weekly quota usage lifecycle, usage cache lifecycle

**Passive weekly quota observation**:
A weekly quota usage observation obtained from information accompanying normal provider activity rather than from a dedicated quota request.
_Avoid_: Header usage, passive quota update

**Dedicated weekly quota acquisition**:
Weekly quota usage acquisition performed through an explicit provider quota request rather than information accompanying normal provider activity.
_Avoid_: Active observation, quota fetch

**Weekly quota observation reconciliation**:
The process of combining dedicated and passive observations into coherent weekly quota usage while preserving or discarding incomplete observation evidence as account and acquisition outcomes require.
_Avoid_: Usage merging, observation cache
