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

**Weekly quota usage lifecycle**:
The progression of weekly quota usage from initial acquisition through fresh observation, temporary staleness, expiration, and session end.
_Avoid_: Usage cache lifecycle

**Passive weekly quota observation**:
A weekly quota usage observation obtained from information accompanying normal provider activity rather than from a dedicated quota request.
_Avoid_: Header usage, passive quota update

**Dedicated weekly quota acquisition**:
Weekly quota usage acquisition performed through an explicit provider quota request rather than information accompanying normal provider activity.
_Avoid_: Active observation, quota fetch
