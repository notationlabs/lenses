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
//
// Invariant: `selections` only holds lenses with at least one tick. The entry
// and the plan derive from it, so a stray empty selection can never widen the
// plan or keep a stale entry alive.

const emptySelection: Selection = { fields: [], follows: {} }

const selectionFor = (selections: Selections, lens: string): Selection =>
  selections[lens] ?? emptySelection

const isEmptySelection = (selection: Selection): boolean =>
  selection.fields.length === 0 && Record.size(selection.follows) === 0

const write = (
  selections: Selections,
  lens: string,
  selection: Selection,
): Selections =>
  isEmptySelection(selection)
    ? Record.remove(selections, lens)
    : Record.set(selections, lens, selection)

export const toggleField = (
  selections: Selections,
  lens: string,
  path: string,
): Selections => {
  const selection = selectionFor(selections, lens)
  const nextFields = Array.contains(selection.fields, path)
    ? Array.filter(selection.fields, field => field !== path)
    : Array.append(selection.fields, path)
  return write(selections, lens, { ...selection, fields: nextFields })
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
  return write(selections, lens, { ...selection, follows: nextFollows })
}

export const setFollowLimit = (
  selections: Selections,
  lens: string,
  path: string,
  limit: number,
): Selections => {
  const selection = selectionFor(selections, lens)
  return write(selections, lens, {
    ...selection,
    follows: Record.set(selection.follows, path, Math.max(1, limit)),
  })
}

// ENTRY
//
// The entry is derived, never accumulated: the preferred lens while it still
// has ticks, otherwise a root of the ticked follow graph (a selected lens
// that no other selected lens follows into), otherwise the first selected
// lens. Ticked lenses on the host being viewed take precedence, so the plan
// re-roots when you tick on another site. Untick everything and the entry
// disappears with it.

const followedTargets = (
  nodes: Nodes,
  selections: Selections,
): ReadonlyArray<string> =>
  pipe(
    Record.toEntries(selections),
    Array.flatMap(([lens, selection]) =>
      pipe(
        Record.keys(selection.follows),
        Array.map(path =>
          pipe(
            Option.fromNullishOr(nodes[lens]),
            Option.flatMap(node =>
              Array.findFirst(node.edges, edge => edge.path === path),
            ),
            Option.map(edge => edge.target),
            Option.filter(target => target !== lens),
          ),
        ),
        Array.getSomes,
      ),
    ),
  )

export const entryFor = (
  nodes: Nodes,
  selections: Selections,
  preferred: Option.Option<string>,
  maybeHost: Option.Option<string>,
): Option.Option<string> =>
  pipe(
    preferred,
    Option.filter(lens => Record.has(selections, lens)),
    Option.orElse(() => {
      const selected = pipe(Record.keys(selections), allSelected =>
        Option.match(maybeHost, {
          onNone: () => allSelected,
          onSome: host => {
            const local = Array.filter(
              allSelected,
              lens => nodes[lens]?.host === host,
            )
            return local.length > 0 ? local : allSelected
          },
        }),
      )
      const targets = followedTargets(nodes, selections)
      return pipe(
        Array.findFirst(selected, lens => !Array.contains(targets, lens)),
        Option.orElse(() => Array.head(selected)),
      )
    }),
  )

// PARAMS

export const readParams = (
  node: LensNode,
  raw: Record<string, string>,
): Record<string, unknown> => {
  const params: Record<string, unknown> = {}
  for (const [key, spec] of Record.toEntries(node.params)) {
    const typed = paramType(spec)
    const rawValue = pipe(
      Option.fromNullishOr(raw[key]),
      Option.filter(input => input !== ''),
      Option.orElse(() => paramDefault(spec)),
    )
    if (typed === 'integer' || typed === 'number') {
      const parsed = Option.flatMap(rawValue, Number.parse)
      if (Option.isSome(parsed)) {
        params[key] = parsed.value
      }
    } else if (Option.isSome(rawValue)) {
      params[key] = rawValue.value
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
    const maybeNode = Option.fromNullishOr(nodes[name])
    const selection = selectionFor(selections, name)
    const base: Select = {
      lens: name,
      params: Option.match(maybeNode, {
        onNone: () => ({}),
        onSome: node => readParams(node, paramValues[name] ?? {}),
      }),
      fields: selection.fields,
      follows: [],
    }
    // On a cycle the lens keeps its fields and params but stops recursing.
    if (Option.isNone(maybeNode) || Array.contains(visited, name)) {
      return base
    }
    const node = maybeNode.value
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
  return build(entry, [])
}

/**
 * The plan is a pure projection of selections: it exists exactly when
 * something is ticked, rooted at the derived entry.
 */
export const planFor = (
  nodes: Nodes,
  selections: Selections,
  paramValues: ParamValues,
  preferredEntry: Option.Option<string>,
  maybeHost: Option.Option<string>,
): Option.Option<Select> =>
  Option.map(entryFor(nodes, selections, preferredEntry, maybeHost), entry =>
    buildSelect(nodes, selections, paramValues, entry),
  )

/** Lenses the plan will actually query. */
export const lensesIn = (select: Select): ReadonlyArray<string> =>
  Array.dedupe(
    Array.prepend(
      Array.flatMap(select.follows, follow => lensesIn(follow.select)),
      select.lens,
    ),
  )

/** Ticked lenses the plan cannot reach from the entry via ticked follows. */
export const unreachedLenses = (
  selections: Selections,
  select: Select,
): ReadonlyArray<string> => {
  const reached = lensesIn(select)
  return Array.filter(
    Record.keys(selections),
    lens => !Array.contains(reached, lens),
  )
}

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
