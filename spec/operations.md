---
title: Operation declarations
---

# Operation declarations

`!validate` parses and validates a raw JSON document into a lens spec (`validateSpec`, `packages/lens/src/validate.ts`).

```operation
validate(raw: json): LensDocument
```

`!deriveSchema` emits a standard JSON Schema for a lens's resolved value (`deriveJsonSchema`, `packages/lens/src/schema.ts`).

```operation
deriveSchema(doc: LensDocument): json
```

`!checkResult` validates a resolved value against the lens's `returns` declaration (`validateResult`, `packages/lens/src/schema.ts`).

```operation
checkResult(doc: LensDocument, value: json): ValidationIssue[]
```

`!execute` runs the resolver pipeline for one call inside the broker (`executeLens`, `packages/lens/src/engine.ts`).

```operation
execute(doc: LensDocument, input: Record<string, json>): CallResult
```

`!evaluateExpression` evaluates one sandboxed JSONata expression (`evaluate`, `packages/lens/src/expr.ts`).

```operation
evaluateExpression(expr: string, data: json, params: Record<string, json>): json
```

Client operations (`LensClient`, `packages/client/src/index.ts`).

```operation
call(request: CallRequest): CallResult
```

```operation
value(request: CallRequest): json
```

```operation
list(): LensSummary[]
```

```operation
update(): CatalogUpdate[]
```

```operation
observe(request: ObserveRequest): CallResult
```

`!bindBroker` connects a client to the persistent broker, spawning or replacing one as needed (`BrowserBridge.bind`, `packages/client/src/bridge.ts`).

```operation
bindBroker(port: integer): BrokerStatus
```

`!runCommand` executes one `lens` CLI invocation (`packages/cli/src/index.ts`).

```operation
runCommand(argv: string[]): CommandResult
```


Internal resolver operations expose the semantic tier boundary already named by the contracts.

```operation
runHttp(resolver: HttpResolver, params: Record<string, json>, io: json, doc: LensDocument): TierResult
```

```operation
runIntercept(resolver: InterceptResolver, params: Record<string, json>, io: json, doc: LensDocument): TierResult
```

```operation
runDom(resolver: DomResolver, params: Record<string, json>, io: json, doc: LensDocument): TierResult
```
