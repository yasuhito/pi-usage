# Pi Usage

Pi Usage presents provider-reported subscription capacity so users can judge their remaining ability to work across AI coding tools.

## Language

**Weekly quota usage**:
The provider-reported percentage of an account’s weighted weekly allowance that has been consumed. It is not calculated from a fixed token denominator.
_Avoid_: Weekly token usage, weekly token limit

**Weekly window**:
A provider-reported quota window whose duration is exactly seven days. Primary or secondary window position alone does not identify it.
_Avoid_: Secondary window

**Stale usage**:
The last successfully observed weekly quota usage when a newer observation temporarily cannot be obtained. It remains presentable for at most ten minutes and never beyond its reported reset time.
_Avoid_: Cached usage, current usage

**Weekly reset countdown**:
The compact remaining time until the provider-reported weekly window reset. It is derived from the weekly window's reset timestamp and shown separately from the available limit reset credit count.
_Avoid_: Credit expiry, reset credit countdown

**Limit reset credit**:
A provider-granted, consumable credit that resets a Codex rate-limit window. It is separate from weekly quota usage and paid extra-usage balances. The footer reports the provider's available count.
_Avoid_: Weekly credit, usage credit

**Weekly quota usage lifecycle**:
The progression of weekly quota usage and its accompanying available limit reset credit count from initial acquisition through fresh observation, temporary staleness, expiration, and session end.
_Avoid_: Usage cache lifecycle

**Passive weekly quota observation**:
A weekly quota usage observation obtained from information accompanying normal provider activity rather than from a dedicated quota request.
_Avoid_: Header usage, passive quota update

**Dedicated weekly quota acquisition**:
Weekly quota usage acquisition performed through an explicit provider quota request rather than information accompanying normal provider activity.
_Avoid_: Active observation, quota fetch

**Weekly quota observation reconciliation**:
The process of combining dedicated and passive observations into coherent weekly quota usage while preserving or discarding incomplete observation evidence as account and acquisition outcomes require.
_Avoid_: Usage merging, observation cache
