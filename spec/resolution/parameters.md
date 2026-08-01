---
title: Validate call parameters
---

# Validate call parameters

## Context

!execute resolves the @caller's input against the document's `params` declarations before any tier runs (`resolveParams`, `packages/lens/src/engine.ts`). The resolved set feeds URL expansion and every resolver expression.

## Rules

- **Unknown parameter rejected:** An input key that no declaration names fails with `unknown parameter "<key>"`.
- **Missing parameter rejected:** A declared parameter with no input value and no `default` fails with `missing parameter "<key>"`.
- **Default fill:** A declared `default` supplies the value when the input omits the key.
- **Type check:** A value must match its declared type — `integer` via integrality, the others via `typeof`.
- **Enum membership:** A value for an enum parameter must be one of the declared values.
