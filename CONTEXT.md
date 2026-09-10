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
