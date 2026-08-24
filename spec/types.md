---
title: Entity declarations
---

# Entity declarations



```entity
type ParameterType = "string" | "number" | "integer" | "boolean"

type ParameterDefault = string | number | boolean | ParamLensDefault

type ParamLensDefault = {
  $lens: string
  field: string
  params?: Record<string, string | number | boolean>
}

type ParameterOptions = {
  type: ParameterType
  default?: ParameterDefault
  enum?: string[]
}

type LensParameter = "string" | "number" | "integer" | "boolean" | ParameterOptions

type NullableReturn = {
  type: ParameterType
  nullable: boolean
}

type LensReference = {
  $lens: string
  params?: Record<string, string>
}

type DefReference = {
  $ref: string
}

type ObjectReturn = {
  type: "object"
  fields?: Record<string, ReturnNode>
}

type ArrayReturn = {
  type: "array"
  items?: ReturnItems
}

type ReturnItems = Record<string, ReturnNode> | DefReference

type ReturnNode = "string" | "number" | "integer" | "boolean" | "null" | NullableReturn | LensReference | DefReference | ObjectReturn | ArrayReturn

type MapSpec = string | Record<string, string>
```

```entity
type HttpBody = {json: string} | {text: string} | {form: Record<string, string>} | {search: Record<string, string>}

type HttpCredentials = boolean | "same-origin-page"

type HttpSource = {
  request: string
  body?: HttpBody
  credentials?: HttpCredentials
  headers?: Record<string, string>
  items?: string
}

type HttpResolver = {
  kind: "http"
  request?: string
  body?: HttpBody
  sources?: Record<string, HttpSource>
  headers?: Record<string, string>
  credentials?: HttpCredentials
  items?: string
  map?: MapSpec
  detect?: Record<string, string>
}

type InterceptResolver = {
  kind: "intercept"
  request?: string
  sources?: Record<string, json>
  items?: string
  map?: MapSpec
  detect?: Record<string, string>
  reloadOnMiss?: boolean
  waitMs?: number
}

type DomResolver = {
  kind: "dom"
  detect?: Record<string, string>
  item?: string
  fields?: Record<string, json>
  post?: string
}

type LlmResolver = {
  kind: "llm"
  prompt: string
  maxSnapshotChars?: integer
}

type Resolver = HttpResolver | InterceptResolver | DomResolver | LlmResolver
```

`$LensDocument` is the canonical JSON lens spec (`packages/core/src/types.ts`).

```entity
type LensDocument = {
  name: string
  description?: string
  url: string
  params?: Record<string, LensParameter>
  loadTimeoutMs?: number
  returns?: ReturnNode
  $defs?: Record<string, ObjectReturn>
  outcomes?: Record<string, json>
  detect?: Record<string, string>
  helpers?: Record<string, string>
  effects: Effects
  perform?: json[]
  resolve: Resolver[]
}
```

```entity
type Effects = {
  reads: string[]
  writes: string[]
  idempotent?: boolean
  cache?: number
}
```

`$CallResult` is the closed result of a lens call.

```entity
type ValueCallResult = {
  kind: "value"
  value: json
  resolver: string
  partial?: boolean
  observed?: string
  cached?: boolean
  warnings?: ValidationIssue[]
}

type OutcomeCallResult = {
  kind: "outcome"
  name: string
  value: json
  resolver: string
  cached?: boolean
  warnings?: ValidationIssue[]
}

type ErrorCallResult = {
  kind: "error"
  message: string
  issues?: ValidationIssue[]
  cached?: boolean
  warnings?: ValidationIssue[]
}

type CallResult = ValueCallResult | OutcomeCallResult | ErrorCallResult
```

```entity
type ValidationIssue = {
  path: string
  message: string
  missing?: boolean
}
```

```entity
type LensSummary = {
  name: string
  shortname: string
  url: string
  description?: string
  params?: json
  effects: Effects
  outcomes: string[]
  warnings?: string[]
}
```

```entity
type CatalogUpdate = {
  source: string
  lenses: integer
}
```

```entity
type CallRequest = {
  lens: string
  params?: Record<string, json>
  timeoutMs?: number
  strict?: boolean
}
```

```entity
type ObserveRequest = {
  target: string
  waitMs?: number
  timeoutMs?: number
  html?: boolean
  request?: string
}
```

`$CapturedResponse` is one JSON response captured from the bound page's network activity, or fetched directly by an http tier.

```entity
type CapturedResponse = {
  url: string
  method: string
  status: number
  body: string
  timestamp: number
}
```

```entity
type BrokerStatus = {
  port: integer
  connected: boolean
  lease: string
  stamp?: string
}
```

```entity
type CommandResult = {
  output: json
  exitCode: integer
}
```


```entity
type TierMiss = {
  kind: "miss"
  observed?: string
}

type TierValue = {
  kind: "value"
  value: json
  resolver: string
  observed?: string
}

type TierOutcome = {
  kind: "outcome"
  name: string
  value: json
  resolver: string
}

type TierResult = TierMiss | TierValue | TierOutcome

type NetworkFailure = {
  message: string
}

type MissingHttpCapability = {
  credentialed: boolean
}

type HttpResponseObserved = {
  status: integer
  url: string
}

type EmptyTierValue = {
  observed: string
}

type MissingCapture = {
  patterns: string[]
}
```


```entity
type ReturnContractSatisfied = {
  declaration: string
}
```
