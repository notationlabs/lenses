---
title: Generate the TypeScript SDK
---
# Generate the TypeScript SDK

## Context

`lens gen ts-sdk` compiles one or more catalogs into typed bindings (`generateTsSdk`, `packages/core/src/generate.ts`; `packages/core/test/generate.test.ts`). `--out` writes the source to a file, otherwise it goes to stdout.

## Rules

- **Dual keys:** The generated `Lenses` map keys every lens by scoped name and by shortname, the shortname entry aliasing the scoped one.
- **Unique names:** A scoped name or shortname appearing twice across the given catalogs fails generation.
- **Defaulted params optional:** A parameter with a declared `default` — literal or $ParamLensDefault — is optional in the params type; one without is required. The default value itself is never emitted into the type.
- **Result typing mirrors the schema:** Declared fields are required, objects stay open via an index signature, `$lens` fields type as `LensRef | null` (narrowed to the target name when the target lens is in the generated set), and nullable primitives union with null.
- **Hoisted defs:** Each `$defs` entry becomes a named exported interface (pascal-cased from the shortname and def name, suffixed on collision) so recursive shapes can be printed.
- **Typed client:** The generated `createLensClient` wraps the base client with `call` and `value` narrowed against the `Lenses` map, and re-exports `LensOutcomeError` and `LensResultError` so callers can branch on outcomes.