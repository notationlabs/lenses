---
title: Derive and enforce the result schema
---

# Derive and enforce the result schema

## Context

A lens's `returns` declaration drives both !deriveSchema (the JSON Schema handed to external codegen and validation) and !checkResult (the check applied to every resolved value). Evidence: `packages/core/src/schema.ts`, `packages/core/test/schema.test.ts`.

## Rules

- **Standard dialect:** !deriveSchema emits JSON Schema draft 2020-12 with `$id` equal to `lens:<name>`, `title` equal to the lens name, and the document `description` when present.
- **Declared fields required:** Every declared object field is required by the derived schema; undeclared fields pass through untouched (loose objects).
- **Lens ref shape:** A `$lens` field validates as the shared `$defs/lensRef` object `{$lens, params?}` or null, matching what materialisation produces.
- **Nullable primitives:** `{type, nullable: true}` validates the primitive or null.
- **Recursive defs:** A `$defs` entry is memoised behind a lazy schema so a def whose fields reference itself resolves to one schema, and the cycle is extracted into JSON Schema `$defs` under an id derived from the lens name and def name.

## Outcomes

- **No declaration, no issues:** !checkResult on a lens without `returns` returns an empty issue list.
- **Issue pointers:** Each $ValidationIssue.path is a JSON pointer into the resolved value with `~` and `/` escaped (`~0`, `~1`).
- **Missing flag:** An issue whose value is absent entirely carries `missing: true`, distinguishing an underfilled resolver tier from a type mismatch.
