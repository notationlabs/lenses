---
title: Execute the resolver pipeline
---

# Execute the resolver pipeline

## Context

!execute runs a $LensDocument's resolver tiers against a bound browser session (or the broker's own process for credential-free http). Evidence: `packages/lens/src/engine.ts`, `packages/lens/src/reconcile.ts`, `packages/lens/test/engine.test.ts`, `packages/lens/test/reconcile.test.ts`.

## Rules

- **Tier order:** Resolver tiers run in declaration order; the document orders them by cost.
- **Miss falls through:** A tier that misses contributes nothing; the engine records the miss description and tries the next tier.
- **Field accumulation:** When the gathered value and a tier's contribution are both plain objects, the contribution fills only fields the gathered value lacks, recursively; otherwise the newest contribution replaces the gathered value.
- **Completion test after materialisation:** After each contribution the engine materialises declared `$lens` fields and stops when the materialised value satisfies `returns` — a declared ref supplied by materialisation counts, and one that cannot bind yet keeps the contract unsatisfied so the tier that supplies its inputs still runs.
- **Satisfaction semantics:** A value satisfies `returns` when every declared field is present and matches its declared type (`satisfiesReturns`): primitives by type, `integer` by integrality, arrays element-wise against their field map or `$ref`, and a `$lens` field by being null, a string, or a callable `{$lens, params?}` reference.

## Outcomes

- **Resolved value:** A satisfied call returns a $CallResult with kind `value`.
- **Contributing resolver:** A value result's `resolver` names the contributing tier, or `reconciled` when more than one tier contributed.
- **Observed provenance:** A value result's `observed` is the landed URL the last contributing tier actually read from; a tier that missed never updates it.
- **Terminal outcome:** A tier that detects an outcome ends the call immediately with kind `outcome`, its name, the outcome value, and the detecting tier.
- **Agent-extract enrichment:** An `agent_extract` outcome reached after earlier tiers gathered fields carries those fields, materialised, under `gathered` in the outcome value.
- **Partial value:** When every tier is exhausted but some fields were gathered, the call returns a value result with `partial: true` so the host will not cache it.

## Failures

- **Parameter rejection:** Invalid call input (per the call-parameter contract) returns an error result rather than throwing.
- **Exhausted resolvers:** When every tier misses and nothing was gathered, the call returns an error `all resolvers exhausted (<last miss>)`, where the last miss names the tier and what it observed — distinguishing a broken selector from a page that was never the one asked for.
