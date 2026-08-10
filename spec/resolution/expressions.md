---
title: Evaluate lens expressions
---

# Evaluate lens expressions

## Context

Every executable field in a lens document (`map`, `detect`, `items`, `post`, helper bodies, `$lens` param expressions) is a JSONata expression string, never JavaScript, so the host can trust the `effects` declaration without parsing per-site code. !evaluateExpression is the one evaluator (`packages/core/src/expr.ts`); `lens eval` runs it offline.

## Rules

- **Parameter bindings:** Each identifier-named call parameter is bound as the JSONata variable `$name`, and the whole set as `$params`.
- **Helper bindings:** Each identifier-named helper is compiled once per source text (a cache keyed by the expression itself) and bound as `$name`.
- **Parameters shadow helpers:** Parameters are bound after helpers, so a declared parameter of the same name wins — a catalogue cannot change what an expression means by adding a helper whose name a document already uses.
- **Truthy detection:** A detect expression triggers its outcome when its result is truthy under JavaScript `Boolean()` (`evaluateBool`).

## Invariants

- **Sandboxed evaluation:** An expression can only read the data and bindings it is given; it cannot reach the network, the DOM, or the host process.
