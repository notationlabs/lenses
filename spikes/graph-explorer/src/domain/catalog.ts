import { Array, Option, Record, Schema as S, String, pipe } from 'effect'
import { ts } from 'foldkit/schema'

// SCHEMA

export const FieldRow = ts('FieldRow', {
  path: S.String,
  label: S.String,
  fieldType: S.String,
  depth: S.Number,
})
export const EdgeRow = ts('EdgeRow', {
  path: S.String,
  label: S.String,
  target: S.String,
  isInArray: S.Boolean,
  paramsSummary: S.String,
  depth: S.Number,
})
export const GroupRow = ts('GroupRow', {
  label: S.String,
  depth: S.Number,
})
export const Row = S.Union([FieldRow, EdgeRow, GroupRow])
export type Row = typeof Row.Type

export const Edge = S.Struct({
  path: S.String,
  target: S.String,
  isInArray: S.Boolean,
})
export type Edge = typeof Edge.Type

export const Outcome = S.Struct({
  name: S.String,
  maybeTarget: S.Option(S.String),
})
export type Outcome = typeof Outcome.Type

export const LensNode = S.Struct({
  name: S.String,
  shortname: S.String,
  host: S.String,
  params: S.Record(S.String, S.Unknown),
  rows: S.Array(Row),
  edges: S.Array(Edge),
  outcomes: S.Array(Outcome),
  isGhost: S.Boolean,
})
export type LensNode = typeof LensNode.Type

export const Nodes = S.Record(S.String, LensNode)
export type Nodes = typeof Nodes.Type

// HELPERS

export const shortName = (name: string): string =>
  pipe(name.split('/'), Array.drop(1), Array.join('/'))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !globalThis.Array.isArray(value)

const getString = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  return typeof value === 'string' ? Option.some(value) : Option.none()
}

const getRecord = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  return isRecord(value) ? Option.some(value) : Option.none()
}

const getLensRef = (value: unknown): Option.Option<string> =>
  isRecord(value) ? getString(value, '$lens') : Option.none()

const hostOf = (url: string): string => {
  try {
    return new URL(url.replace(/\{[^}]+\}/g, 'x')).host
  } catch {
    return 'unknown'
  }
}

const summariseEdgeParams = (params: Record<string, unknown>): string =>
  pipe(
    Record.toEntries(params),
    Array.map(([key, value]) => `${key} ← ${value}`),
    Array.join(', '),
  )

export const paramType = (spec: unknown): string => {
  if (typeof spec === 'string') {
    return spec
  }
  if (isRecord(spec)) {
    return Option.getOrElse(getString(spec, 'type'), () => '?')
  }
  return '?'
}

export const paramDefault = (spec: unknown): Option.Option<string> => {
  if (isRecord(spec) && spec['default'] !== undefined) {
    return Option.some(globalThis.String(spec['default']))
  }
  return Option.none()
}

// ANALYSE A LENS DOCUMENT'S STATIC SHAPE

interface WalkState {
  rows: Array<Row>
  edges: Array<Edge>
}

const walkSchema = (
  state: WalkState,
  schema: unknown,
  path: ReadonlyArray<string>,
  isInArray: boolean,
): void => {
  const label = Option.getOrElse(Array.last(path), () => '')
  const depth = Math.max(path.length - 1, 0)

  const maybeLens = getLensRef(schema)
  if (Option.isSome(maybeLens) && isRecord(schema)) {
    const joined = Array.join(path, '.')
    const params = Option.getOrElse(getRecord(schema, 'params'), () => ({}))
    state.rows.push(
      EdgeRow({
        path: joined,
        label,
        target: maybeLens.value,
        isInArray,
        paramsSummary: summariseEdgeParams(params),
        depth,
      }),
    )
    state.edges.push({ path: joined, target: maybeLens.value, isInArray })
    return
  }
  if (typeof schema === 'string') {
    state.rows.push(
      FieldRow({
        path: Array.join(path, '.'),
        label,
        fieldType: schema,
        depth,
      }),
    )
    return
  }
  if (!isRecord(schema)) {
    return
  }
  const isNested = Option.isSome(Array.last(path))
  const items = schema['items']
  if (schema['type'] === 'array' && items !== undefined) {
    if (isNested) {
      state.rows.push(GroupRow({ label: `${label}[]`, depth }))
    }
    if (
      isRecord(items) &&
      Option.isNone(getLensRef(items)) &&
      items['type'] === undefined
    ) {
      for (const [key, value] of Record.toEntries(items)) {
        walkSchema(state, value, Array.append(path, key), true)
      }
    } else {
      walkSchema(state, items, path, true)
    }
    return
  }
  const fields = schema['fields']
  if (schema['type'] === 'object' && isRecord(fields)) {
    if (isNested) {
      state.rows.push(GroupRow({ label, depth }))
    }
    for (const [key, value] of Record.toEntries(fields)) {
      walkSchema(state, value, Array.append(path, key), isInArray)
    }
    return
  }
  const fieldType = getString(schema, 'type')
  state.rows.push(
    FieldRow({
      path: Array.join(path, '.'),
      label,
      fieldType: Option.getOrElse(fieldType, () => '?'),
      depth,
    }),
  )
}

export const analyse = (doc: unknown): Option.Option<LensNode> => {
  if (!isRecord(doc)) {
    return Option.none()
  }
  return Option.map(getString(doc, 'name'), name => {
    const state: WalkState = { rows: [], edges: [] }
    walkSchema(state, doc['returns'], [], false)

    const outcomes = pipe(
      Option.getOrElse(getRecord(doc, 'outcomes'), () => ({})),
      Record.toEntries,
      Array.map(([outcomeName, outcome]) =>
        Outcome.make({
          name: outcomeName,
          maybeTarget: getLensRef(outcome),
        }),
      ),
    )

    return LensNode.make({
      name,
      shortname: shortName(name),
      host: pipe(
        getString(doc, 'url'),
        Option.map(hostOf),
        Option.getOrElse(() => 'unknown'),
      ),
      params: Option.getOrElse(getRecord(doc, 'params'), () => ({})),
      rows: state.rows,
      edges: state.edges,
      outcomes,
      isGhost: false,
    })
  })
}

// GRAPH ASSEMBLY

export const targetsOf = (node: LensNode): ReadonlyArray<string> =>
  Array.appendAll(
    Array.map(node.edges, edge => edge.target),
    Array.getSomes(Array.map(node.outcomes, outcome => outcome.maybeTarget)),
  )

const ghostNode = (name: string, host: string): LensNode =>
  LensNode.make({
    name,
    shortname: shortName(name),
    host,
    params: {},
    rows: [],
    edges: [],
    outcomes: [],
    isGhost: true,
  })

export const buildNodes = (docs: ReadonlyArray<unknown>): Nodes => {
  const analysed = Array.getSomes(Array.map(docs, analyse))
  const nodes: Record<string, LensNode> = {}
  for (const node of analysed) {
    nodes[node.name] = node
  }
  for (const node of analysed) {
    for (const target of targetsOf(node)) {
      nodes[target] ??= ghostNode(target, node.host)
    }
  }
  return nodes
}

export const hostsOf = (nodes: Nodes): ReadonlyArray<string> =>
  pipe(
    Record.values(nodes),
    Array.map(node => node.host),
    Array.dedupe,
    Array.sort(String.Order),
  )

export const nodesForHost = (
  nodes: Nodes,
  host: string,
): ReadonlyArray<LensNode> =>
  pipe(
    Record.values(nodes),
    Array.filter(node => node.host === host),
  )
