import { Array, Option, Record, pipe } from 'effect'

import { Select } from './select'

// SPECIAL VALUES THE API EMBEDS IN RESULTS

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !globalThis.Array.isArray(value)

export interface LensRef {
  readonly lens: string
  readonly params: unknown
}

export const getLensRef = (value: unknown): Option.Option<LensRef> => {
  if (isRecord(value) && typeof value['$lens'] === 'string') {
    return Option.some({ lens: value['$lens'], params: value['params'] ?? {} })
  }
  return Option.none()
}

export const getOutcome = (
  value: unknown,
): Option.Option<{ readonly name: string; readonly hint: string }> => {
  if (isRecord(value) && typeof value['$outcome'] === 'string') {
    const hint = value['hint']
    return Option.some({
      name: value['$outcome'],
      hint: typeof hint === 'string' ? hint : '',
    })
  }
  return Option.none()
}

export const getError = (value: unknown): Option.Option<string> => {
  if (isRecord(value) && typeof value['$error'] === 'string') {
    return Option.some(value['$error'])
  }
  return Option.none()
}

export const isSpecial = (value: unknown): boolean =>
  Option.isSome(getLensRef(value)) ||
  Option.isSome(getOutcome(value)) ||
  Option.isSome(getError(value))

// FLATTEN A NESTED RESULT TO JOIN-TABLE ROWS

export type FlatRow = Record<string, unknown>

/** Arrays go vertical, sibling keys go cartesian. */
export const flatten = (
  value: unknown,
  prefix = '',
): ReadonlyArray<FlatRow> => {
  if (globalThis.Array.isArray(value)) {
    const rows = Array.flatMap(value, element => flatten(element, prefix))
    return Array.match(rows, {
      onEmpty: (): ReadonlyArray<FlatRow> => [{}],
      onNonEmpty: nonEmptyRows => nonEmptyRows,
    })
  }
  if (isRecord(value) && !isSpecial(value)) {
    let rows: ReadonlyArray<FlatRow> = [{}]
    for (const [key, sub] of Record.toEntries(value)) {
      const subRows = flatten(sub, prefix === '' ? key : `${prefix}.${key}`)
      rows = Array.flatMap(rows, row =>
        Array.map(subRows, subRow => ({ ...row, ...subRow })),
      )
    }
    return rows
  }
  return [{ [prefix === '' ? 'value' : prefix]: value }]
}

export const columnsOf = (
  rows: ReadonlyArray<FlatRow>,
): ReadonlyArray<string> =>
  pipe(
    Array.flatMap(rows, row => Record.keys(row)),
    Array.dedupe,
  )

// SAMPLE VALUES FOR GRAPH ANNOTATION

const firstAt = (value: unknown, path: string): unknown => {
  let current: unknown = value
  for (const segment of path.split('.')) {
    while (globalThis.Array.isArray(current)) {
      current = current[0]
    }
    if (!isRecord(current)) {
      return undefined
    }
    current = current[segment]
  }
  while (globalThis.Array.isArray(current)) {
    current = current[0]
  }
  return current
}

export type Samples = Record<string, Record<string, string>>

/** First primitive seen at each selected path, keyed lens -> path, for the cards to display. */
export const collectSamples = (select: Select, data: unknown): Samples => {
  const samples: Record<string, Record<string, string>> = {}

  const mark = (lens: string, path: string, value: unknown) => {
    if (value === undefined || value === null || typeof value === 'object') {
      return
    }
    samples[lens] = { ...samples[lens], [path]: globalThis.String(value) }
  }

  const walk = (currentSelect: Select, value: unknown): void => {
    if (value === undefined || value === null || isSpecial(value)) {
      return
    }
    for (const path of currentSelect.fields) {
      mark(currentSelect.lens, path, firstAt(value, path))
    }
    for (const follow of currentSelect.follows) {
      const sub = firstAt(value, follow.path)
      const maybeOutcome = getOutcome(sub)
      if (Option.isSome(maybeOutcome)) {
        mark(currentSelect.lens, follow.path, `⚠ ${maybeOutcome.value.name}`)
      }
      if (sub !== undefined && !isSpecial(sub)) {
        walk(follow.select, sub)
      }
    }
  }

  walk(select, data)
  return samples
}
