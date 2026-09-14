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

**Stale capacity**:
The last successfully observed provider capacity information when a newer observation temporarily cannot be obtained. Its retention period is provider-specific: Codex and OpenRouter retain it for at most ten minutes from observation, while Claude retains it until reset; a provider-reported reset or expiration shortens retention when one exists.
_Avoid_: Stale usage, cached usage, current usage

**Stale capacity lifecycle**:
The progression of observed provider capacity from fresh information through temporary staleness to provider-specific expiration, invalidation, or session end. It applies across unlike capacity measures without treating them as the same quantity.
_Avoid_: Usage cache lifecycle, weekly usage lifecycle

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

**OpenRouter key remaining spend**:
The provider-reported US-dollar amount remaining under an OpenRouter API key’s configured spending limit. It is scoped to that key and is distinct from the account’s purchased-credit balance.
_Avoid_: OpenRouter account credit balance, OpenRouter credits, weekly subscription usage

**OpenRouter account credit balance**:
The OpenRouter account’s total purchased credits minus its total usage, obtained with a Management Key. It is account-scoped and distinct from an individual API key’s configured spending limit.
_Avoid_: OpenRouter key remaining spend, OpenRouter key limit, weekly subscription usage

**Monitored provider capacity session**:
The session-scoped ownership of all monitored providers’ capacity information, including startup, replacement, event routing, presentation, and shutdown. It coordinates independent provider lifecycles without treating unlike capacity measures, such as weekly subscription usage and OpenRouter account credit balance, as the same quantity.
_Avoid_: Weekly subscription usage session, provider monitor session

**Passive weekly quota observation**:
A weekly quota usage observation obtained from information accompanying normal provider activity rather than from a dedicated quota request.
_Avoid_: Header usage, passive quota update

**Dedicated weekly quota acquisition**:
Weekly quota usage acquisition performed through an explicit provider quota request rather than information accompanying normal provider activity.
_Avoid_: Active observation, quota fetch

**Provider JSON exchange**:
A single direct JSON request-response interaction with a provider made within capacity acquisition. It excludes credential resolution, cross-process acquisition coordination, and interpretation into provider capacity.
_Avoid_: Provider acquisition, coordinated acquisition

**Weekly quota observation reconciliation**:
The process of combining dedicated and passive observations into coherent weekly quota usage while preserving or discarding incomplete observation evidence as account and acquisition outcomes require.
_Avoid_: Usage merging, observation cache

**Weekly quota observation provenance**:
The session-local causal order and account-continuity interval associated with dedicated or passive weekly quota evidence. Reconciliation accepts evidence only within its continuity interval and does not let older evidence replace newer evidence; the provenance contains no credential, account identifier, or provider data.
_Avoid_: Observation timestamp, account identifier, completion order
