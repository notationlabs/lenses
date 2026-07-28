import { Array, Number, Option, Record, Schema as S, pipe } from 'effect'

import { LensNode, Nodes, paramDefault, paramType } from './catalog'

// SCHEMA

export const Selection = S.Struct({
  fields: S.Array(S.String),
  follows: S.Record(S.String, S.Number),
})
export type Selection = typeof Selection.Type

export const Selections = S.Record(S.String, Selection)
export type Selections = typeof Selections.Type

export const ParamValues = S.Record(S.String, S.Record(S.String, S.String))
export type ParamValues = typeof ParamValues.Type

/** The plan sent to the API. Kept as plain types: it is derived data, never Model state. */
export interface Select {
  readonly lens: string
  readonly params: Record<string, unknown>
  readonly fields: ReadonlyArray<string>
  readonly follows: ReadonlyArray<Follow>
}
export interface Follow {
  readonly path: string
  readonly limit: number
  readonly select: Select
}

export const DEFAULT_FOLLOW_LIMIT = 3

// SELECTION EDITS

const emptySelection: Selection = { fields: [], follows: {} }

const selectionFor = (selections: Selections, lens: string): Selection =>
  selections[lens] ?? emptySelection

export const toggleField = (
  selections: Selections,
  lens: string,
  path: string,
): Selections => {
  const selection = selectionFor(selections, lens)
  const nextFields = Array.contains(selection.fields, path)
    ? Array.filter(selection.fields, field => field !== path)
    : Array.append(selection.fields, path)
  return { ...selections, [lens]: { ...selection, fields: nextFields } }
}

export const toggleFollow = (
  selections: Selections,
  lens: string,
  path: string,
): Selections => {
  const selection = selectionFor(selections, lens)
  const nextFollows = Record.has(selection.follows, path)
    ? Record.remove(selection.follows, path)
    : Record.set(selection.follows, path, DEFAULT_FOLLOW_LIMIT)
  return { ...selections, [lens]: { ...selection, follows: nextFollows } }
}

export const setFollowLimit = (
  selections: Selections,
  lens: string,
  path: string,
  limit: number,
): Selections => {
  const selection = selectionFor(selections, lens)
  if (!Record.has(selection.follows, path)) {
    return selections
  }
  return {
    ...selections,
    [lens]: {
      ...selection,
      follows: Record.set(selection.follows, path, Math.max(1, limit)),
    },
  }
}

export const hasAnySelection = (selections: Selections): boolean =>
  pipe(
    Record.values(selections),
    Array.some(
      selection =>
        selection.fields.length > 0 || Record.size(selection.follows) > 0,
    ),
  )

// PARAMS

export const readParams = (
  node: LensNode,
  raw: Record<string, string>,
): Record<string, unknown> => {
  const params: Record<string, unknown> = {}
  for (const [key, spec] of Record.toEntries(node.params)) {
    const typed = paramType(spec)
    const value = pipe(
      Option.fromNullishOr(raw[key]),
      Option.filter(input => input !== ''),
      Option.orElse(() => paramDefault(spec)),
    )
    if (Option.isSome(value)) {
      params[key] =
        typed === 'integer' || typed === 'number'
          ? globalThis.Number(value.value)
          : value.value
    }
  }
  return params
}

// PLAN

export const buildSelect = (
  nodes: Nodes,
  selections: Selections,
  paramValues: ParamValues,
  entry: string,
): Select => {
  const build = (name: string, visited: ReadonlyArray<string>): Select => {
    const node = nodes[name]
    const selection = selections[name]
    const base: Select = {
      lens: name,
      params: {},
      fields: selection?.fields ?? [],
      follows: [],
    }
    if (node === undefined || selection === undefined) {
      return base
    }
    if (Array.contains(visited, name)) {
      return base
    }
    const nextVisited = Array.append(visited, name)
    const follows = pipe(
      Record.toEntries(selection.follows),
      Array.map(([path, limit]) =>
        pipe(
          Array.findFirst(node.edges, edge => edge.path === path),
          Option.flatMap(edge => Option.fromNullishOr(nodes[edge.target])),
          Option.filter(target => !target.isGhost),
          Option.map(target => ({
            path,
            limit,
            select: build(target.name, nextVisited),
          })),
        ),
      ),
      Array.getSomes,
    )
    return { ...base, follows }
  }

  const select = build(entry, [])
  const entryNode = nodes[entry]
  const params =
    entryNode === undefined
      ? {}
      : readParams(entryNode, paramValues[entry] ?? {})
  return { ...select, params }
}

export const planFor = (
  nodes: Nodes,
  selections: Selections,
  paramValues: ParamValues,
  maybeEntry: Option.Option<string>,
): Option.Option<Select> =>
  pipe(
    maybeEntry,
    Option.filter(() => hasAnySelection(selections)),
    Option.map(entry => buildSelect(nodes, selections, paramValues, entry)),
  )

/** Rough page-load estimate: each follow across an array multiplies by its limit. */
export const estimateCalls = (nodes: Nodes, select: Select): number =>
  1 +
  Number.sumAll(
    Array.map(select.follows, follow => {
      const isInArray = pipe(
        Option.fromNullishOr(nodes[select.lens]),
        Option.flatMap(node =>
          Array.findFirst(node.edges, edge => edge.path === follow.path),
        ),
        Option.match({
          onNone: () => false,
          onSome: edge => edge.isInArray,
        }),
      )
      return (
        (isInArray ? follow.limit : 1) * estimateCalls(nodes, follow.select)
      )
    }),
  )
