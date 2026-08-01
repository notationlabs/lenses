---
title: Validate a lens document
---

# Validate a lens document

## Context

The @author writes a lens as one JSON file. !validate accepts the raw JSON and returns the parsed $LensDocument or throws. Evidence: `packages/lens/src/validate.ts`, `packages/lens/test/validate.test.ts`.

## Rules

- **Scoped name:** $LensDocument.name must match `@scope/site/name` — three lowercase `[a-z0-9_-]` segments with a leading `@`.
- **Absolute URL template:** $LensDocument.url, with each `{name}` hole substituted, must parse as an absolute URL.
- **Closed keys:** Every object in the document rejects keys its schema does not declare (strict objects at every level).
- **Parameter declaration forms:** A parameter is a bare type (`string`, `number`, `integer`, `boolean`) or an object `{type, default?, enum?}`.
- **Enum is string-only:** A parameter declaring `enum` must have type `string`, and `enum` must be non-empty.
- **Default agrees with declaration:** A declared literal `default` must match the parameter's type (`integer` requires an integer) and, when `enum` is present, be one of the enum values.
- **Ref default is structural here:** A `default` may instead be a $ParamLensDefault `{$lens, field, params?}` — `$lens` must be a scoped lens name and `params` values must be literals (string, number, boolean). Type agreement with the target's field and enum membership are checked by the host at resolution time, because a single document cannot see the target. The `field` key is only legal on a parameter default, never on a `returns` reference.
- **Returns grammar:** Each `returns` node is a primitive name (`string`, `number`, `integer`, `boolean`, `null`), a nullable primitive `{type, nullable: true}`, a lens reference `{$lens, params?}`, a def reference `{$ref}`, `{type: "object", fields?}`, or `{type: "array", items?}` where `items` is a field map or a `{$ref}`.
- **Defs are object shapes:** Every `$defs` entry must be `{type: "object", fields?}`; refs exist so a field map can contain itself, and only object types carry the recursive edge.
- **Refs resolve:** Every `{$ref}` in `returns` or `$defs` must name an entry in `$defs`.
- **URL holes declared:** Every `{name}` hole in $LensDocument.url must name a declared parameter.
- **Http holes declared:** Every hole in an http resolver's `request`, `headers` values, and chained source requests must name a declared parameter or a source declared earlier in the same resolver (dotted holes such as `{orgs.0.uuid}` bind from the named source's body).
- **Selector holes declared:** Every hole in a dom resolver's `item`, field `selector`, or field `scope` must name a declared parameter.
- **At least one resolver:** $LensDocument.resolve must contain at least one resolver.
- **Resolver kinds:** Each `resolve` entry is discriminated by `kind`, one of `http`, `intercept`, `dom`, or `llm`.
- **Http request exclusivity:** An http resolver takes at most one of `request` or `sources`; when `sources` is present it must be non-empty.
- **Intercept request exclusivity:** An intercept resolver needs exactly one of `request` or `sources`; `sources`, when present, must be non-empty.
- **Llm prompt required:** An llm resolver must declare `prompt`; `maxSnapshotChars`, when present, must be a positive integer.
- **Sibling spelling warning:** A dom field using `sibling: true` without `scope` produces a non-fatal warning steering the @author to `"scope": "+"` (`specWarnings`).
- **Undeclared outcome warning:** A `detect` entry (document-level or resolver-level) naming an outcome that `outcomes` does not declare produces a non-fatal warning, because the outcome still fires and the caller gets no `hint` to recover with.

## Failures

- **Invalid document:** A document that fails validation throws an error beginning `invalid lens spec:` and listing each issue at its JSON pointer.
  - When a union branch got further than the union node itself, the deeper branch issues are reported instead of the union summary, so the message locates the actual mistake.
