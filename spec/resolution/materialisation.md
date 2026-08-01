---
title: Materialise lens references
---

# Materialise lens references

## Context

A `returns` field declared as `{$lens, params?}` becomes a callable cross-lens reference in the result. Evidence: `packages/lens/src/materialise.ts`, `packages/lens/test/materialise.test.ts`.

## Rules

- **Declarative refs:** A field declaring a `$lens` reference materialises from the row's other fields; no resolver needs to emit the key.
- **Row-scoped binding:** Each declared param expression evaluates against the containing object, with call parameters bound as variables.
- **Emitted refs preserved:** A callable `{$lens, params?}` reference a resolver emitted is kept as-is.
- **Explicit null suppresses:** A resolver that emits null for a `$lens` field suppresses the reference.
- **Deferred binding:** A never-emitted ref whose params do not bind stays absent on non-final passes — keeping the return contract unsatisfied so a later tier can supply its inputs — and settles to null on the final pass instead of leaving a hole.
- **Unbindable is null:** A ref whose param expressions throw, or bind to null or undefined, materialises as null — the value the field's own schema endorses — never as a bare placeholder object.
- **Paramless refs:** A reference whose declaration has no params materialises as `{$lens}` alone.
- **Defs followed through values:** A `$ref` field schema is dereferenced through `$defs` while descending the value, so a self-referencing def bottoms out with the data.
- **No `field` on result refs:** The `{$lens, field, params?}` form is a parameter default only ($ParamLensDefault); a `returns` reference stays `{$lens, params?}` — result refs are lazy join tokens the caller follows, while a parameter default must become an eager scalar before URL expansion, and one shape must not carry two evaluation strategies.
