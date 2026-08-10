---
title: Validate call parameters
---

# Validate call parameters

## Context

!execute resolves the @caller's input against the document's `params` declarations before any tier runs (`resolveParams`, `packages/core/src/engine.ts`). The resolved set feeds URL expansion and every resolver expression. A default may also be a $ParamLensDefault — a `{$lens, field, params?}` reference resolved by the @host (the client) before the engine runs, so the engine only ever sees concrete values (`packages/client/src/index.ts`, `packages/client/test/client.test.ts`).

## Rules

- **Unknown parameter rejected:** An input key that no declaration names fails with `unknown parameter "<key>"`.
- **Missing parameter rejected:** A declared parameter with no input value and no `default` fails with `missing parameter "<key>"`.
- **Default fill:** A declared literal `default` supplies the value when the input omits the key.
- **Type check:** A value must match its declared type — `integer` via integrality, the others via `typeof`.
- **Enum membership:** A value for an enum parameter must be one of the declared values.
- **Engine never resolves ref defaults:** A parameter whose input is absent and whose `default` is a $ParamLensDefault fails in the engine with `unresolved parameter default "<key>"` — reaching the engine unresolved is a host bug, not a missing input.
- **Host pre-resolution:** Before calling the engine, the client fills each omitted parameter whose default is a $ParamLensDefault by calling the target lens (through its own `call`, so caching, validation, and nested ref defaults apply) and projecting the named `field` from the result.
- **Pre-call agreement:** Before spending the call, the target's `returns` must be an object declaring `field` as a top-level non-nullable primitive that agrees with the parameter's type (`integer` satisfies `number`); anything else fails without a browser call.
- **Projected value re-checked:** The projected value passes through the normal type and enum checks like any caller-supplied input.
- **Strict failure propagation:** A target that returns an outcome, an error, a partial result, or a missing or null `field` fails the outer call with an error naming the parameter and target lens (`default for "<key>" via <lens>: …`) — never a silent fall-through to `missing parameter`.
- **Cycle rejected:** Re-entering a call whose `(lens, canonical params)` identity is already on the default-resolution stack fails as a circular parameter default.
- **Bounded resolution:** One outer call resolves at most 8 ref-default calls, and a default chain at most 4 deep; exceeding either fails the outer call.
