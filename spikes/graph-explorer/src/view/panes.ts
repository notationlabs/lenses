import clsx from 'clsx'
import { Array, Match as M, Option, Record, pipe } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, html } from 'foldkit/html'

import { shortName } from '../domain/catalog'
import {
  FlatRow,
  columnsOf,
  flatten,
  getError,
  getLensRef,
  getOutcome,
} from '../domain/result'
import { Select } from '../domain/select'
import {
  ClickedClear,
  ClickedRun,
  Message,
  ResultView,
  SelectedResultView,
} from '../message'
import { Model } from '../model'

// QUERY PANE

const SELECTION_HINT = 'tick fields on a site graph…'

export const queryPaneView = (
  model: Model,
  maybePlan: Option.Option<{ select: Select; estimatedCalls: number }>,
): Html => {
  const h = html<Message>()

  const isRunning = AsyncData.isPending(model.run)

  const status = AsyncData.match(model.run, {
    onIdle: () => '',
    onLoading: () => 'running… (tabs open in your Chrome)',
    onRefreshing: () => 'running… (tabs open in your Chrome)',
    onSuccess: () => 'done',
    onStale: ({ error }) => `failed: ${error}`,
    onFailure: error => `failed: ${error}`,
  })

  return h.div(
    [h.Class('pane query')],
    [
      h.div([h.Class('pane-head')], [h.h3([], ['Query'])]),
      h.div(
        [h.Class('plan')],
        [
          Option.match(maybePlan, {
            onNone: () => SELECTION_HINT,
            onSome: ({ select }) => JSON.stringify(select, null, 2),
          }),
        ],
      ),
      h.div(
        [h.Class('pane-foot')],
        [
          h.div(
            [h.Class('cost')],
            [
              Option.match(maybePlan, {
                onNone: () => '',
                onSome: ({ estimatedCalls }) =>
                  `≈ ${estimatedCalls} page loads (cache permitting)`,
              }),
            ],
          ),
          h.button(
            [
              h.Class('run'),
              h.Disabled(Option.isNone(maybePlan) || isRunning),
              h.OnClick(ClickedRun()),
            ],
            ['Run'],
          ),
          h.button([h.Class('clear'), h.OnClick(ClickedClear())], ['Clear']),
          h.div([h.Class('status')], [status]),
        ],
      ),
    ],
  )
}

// RESULT PANE

const badge = (kind: string, label: string): Html => {
  const h = html<Message>()
  return h.span([h.Class(`badge ${kind}`)], [label])
}

const treeView = (value: unknown): Html => {
  const h = html<Message>()

  if (globalThis.Array.isArray(value)) {
    const rows: ReadonlyArray<unknown> = value
    if (rows.length === 0) {
      return h.span([], ['[]'])
    }
    const columns = pipe(
      Array.flatMap(rows, row =>
        typeof row === 'object' &&
        row !== null &&
        !globalThis.Array.isArray(row)
          ? Record.keys(row)
          : [],
      ),
      Array.dedupe,
    )
    if (columns.length === 0) {
      return h.span([], [JSON.stringify(value)])
    }
    return h.table(
      [],
      [
        h.tr(
          [],
          Array.map(columns, column => h.th([], [column])),
        ),
        ...Array.map(rows, row =>
          h.tr(
            [],
            Array.map(columns, column =>
              h.td(
                [],
                [
                  treeView(
                    typeof row === 'object' && row !== null
                      ? Record.get(row, column).pipe(
                          Option.getOrElse(() => undefined),
                        )
                      : undefined,
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    )
  }

  if (typeof value === 'object' && value !== null) {
    const maybeError = getError(value)
    if (Option.isSome(maybeError)) {
      return badge('err', `error: ${maybeError.value}`)
    }
    const maybeOutcome = getOutcome(value)
    if (Option.isSome(maybeOutcome)) {
      const { name, hint } = maybeOutcome.value
      return badge('outcome', name + (hint === '' ? '' : ` — ${hint}`))
    }
    const maybeRef = getLensRef(value)
    if (Option.isSome(maybeRef)) {
      const { lens, params } = maybeRef.value
      return badge('ref', `→ ${shortName(lens)} ${JSON.stringify(params)}`)
    }
    return h.table(
      [h.Class('kv')],
      Array.map(Record.toEntries(value), ([key, sub]) =>
        h.tr([], [h.td([], [key]), h.td([], [treeView(sub)])]),
      ),
    )
  }

  return h.span(
    [],
    [value === null || value === undefined ? '∅' : globalThis.String(value)],
  )
}

const joinTableView = (data: unknown): Html => {
  const h = html<Message>()
  const rows: ReadonlyArray<FlatRow> = flatten(data)
  const columns = columnsOf(rows)
  if (columns.length === 0) {
    return treeView(data)
  }
  return h.div(
    [],
    [
      h.div([h.Class('row-count')], [`${rows.length} rows`]),
      h.table(
        [],
        [
          h.tr(
            [],
            Array.map(columns, column => h.th([], [column])),
          ),
          ...Array.map(rows, row =>
            h.tr(
              [],
              Array.map(columns, column => h.td([], [treeView(row[column])])),
            ),
          ),
        ],
      ),
    ],
  )
}

const viewToggle = (model: Model, target: ResultView, label: string): Html => {
  const h = html<Message>()
  return h.button(
    [
      h.Class(clsx('view-toggle', { on: model.resultView === target })),
      h.OnClick(SelectedResultView({ view: target })),
    ],
    [label],
  )
}

export const resultPaneView = (model: Model): Html => {
  const h = html<Message>()

  const body = AsyncData.match(model.run, {
    onIdle: () => h.empty,
    onLoading: () => h.empty,
    onRefreshing: () => h.empty,
    onFailure: () => h.empty,
    onStale: ({ data }) => renderData(model, data),
    onSuccess: data => renderData(model, data),
  })

  return h.div(
    [h.Class('pane result')],
    [
      h.div(
        [h.Class('pane-head')],
        [
          h.h3([], ['Result']),
          viewToggle(model, 'JoinTable', 'join table'),
          viewToggle(model, 'Tree', 'tree'),
        ],
      ),
      h.div([h.Class('result-body')], [body]),
    ],
  )
}

const renderData = (model: Model, data: unknown): Html =>
  M.value(model.resultView).pipe(
    M.withReturnType<Html>(),
    M.when('JoinTable', () => joinTableView(data)),
    M.when('Tree', () => treeView(data)),
    M.exhaustive,
  )
