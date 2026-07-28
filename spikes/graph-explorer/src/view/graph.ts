import clsx from 'clsx'
import { Array, Match as M, Option, Record, pipe } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, html } from 'foldkit/html'

import {
  EdgeRow,
  FieldRow,
  GroupRow,
  LensNode,
  Nodes,
  paramDefault,
  paramType,
  shortName,
} from '../domain/catalog'
import { Position, cardNodes, edgeLines, portalNodes } from '../domain/layout'
import { DEFAULT_FOLLOW_LIMIT, Selection } from '../domain/select'
import {
  ClickedSetEntry,
  Message,
  PressedCardTitle,
  ToggledField,
  ToggledFollow,
  UpdatedFollowLimit,
  UpdatedParam,
} from '../message'
import { Model } from '../model'
import { siteRouter, sitesRouter } from '../route'

const cssId = (value: string): string => value.replace(/[^a-zA-Z0-9]/g, '_')

const ROW_INDENT_BASE = 10
const ROW_INDENT_STEP = 12

const sampleView = (model: Model, lens: string, path: string): Html => {
  const h = html<Message>()
  const maybeSample = Option.fromNullishOr(model.samples[lens]?.[path])
  return Option.match(maybeSample, {
    onNone: () => h.empty,
    onSome: sample =>
      h.span(
        [h.Class('sample'), h.Title(sample)],
        [sample.length > 24 ? `${sample.slice(0, 24)}…` : sample],
      ),
  })
}

const fieldRowView = (
  model: Model,
  node: LensNode,
  selection: Option.Option<Selection>,
  row: typeof FieldRow.Type,
): Html => {
  const h = html<Message>()
  const inputId = cssId(node.name + row.path)
  const isTicked = Option.match(selection, {
    onNone: () => false,
    onSome: current => Array.contains(current.fields, row.path),
  })

  return h.div(
    [
      h.Class('row field'),
      h.Style({
        paddingLeft: `${ROW_INDENT_BASE + row.depth * ROW_INDENT_STEP}px`,
      }),
    ],
    [
      h.input([
        h.Type('checkbox'),
        h.Id(inputId),
        h.Checked(isTicked),
        h.OnClick(ToggledField({ lens: node.name, path: row.path })),
      ]),
      h.label([h.For(inputId)], [row.label]),
      h.span([h.Class('type')], [row.fieldType]),
      sampleView(model, node.name, row.path),
    ],
  )
}

const edgeRowView = (
  model: Model,
  node: LensNode,
  selection: Option.Option<Selection>,
  row: typeof EdgeRow.Type,
): Html => {
  const h = html<Message>()
  const inputId = cssId(node.name + row.path)
  const maybeLimit = pipe(
    selection,
    Option.flatMap(current => Option.fromNullishOr(current.follows[row.path])),
  )

  return h.div(
    [
      h.Class('row edge'),
      h.Style({
        paddingLeft: `${ROW_INDENT_BASE + row.depth * ROW_INDENT_STEP}px`,
      }),
    ],
    [
      h.input([
        h.Type('checkbox'),
        h.Id(inputId),
        h.Checked(Option.isSome(maybeLimit)),
        h.OnClick(ToggledFollow({ lens: node.name, path: row.path })),
      ]),
      h.label([h.For(inputId)], [row.label]),
      h.span(
        [h.Class('type'), h.Title(row.paramsSummary)],
        [`→ ${shortName(row.target)}`],
      ),
      row.isInArray
        ? h.input([
            h.Class('limit'),
            h.Type('number'),
            h.Min('1'),
            h.Title('max refs to expand'),
            h.Value(
              String(Option.getOrElse(maybeLimit, () => DEFAULT_FOLLOW_LIMIT)),
            ),
            h.OnInput(value =>
              UpdatedFollowLimit({ lens: node.name, path: row.path, value }),
            ),
          ])
        : h.empty,
      sampleView(model, node.name, row.path),
    ],
  )
}

const groupRowView = (row: typeof GroupRow.Type): Html => {
  const h = html<Message>()
  return h.div(
    [
      h.Class('row group'),
      h.Style({
        paddingLeft: `${ROW_INDENT_BASE + row.depth * ROW_INDENT_STEP}px`,
      }),
    ],
    [row.label],
  )
}

const paramsView = (model: Model, node: LensNode): Html => {
  const h = html<Message>()
  if (Record.size(node.params) === 0) {
    return h.empty
  }
  return h.div(
    [h.Class('params')],
    Array.map(Record.toEntries(node.params), ([key, spec]) =>
      h.keyed('div')(
        key,
        [],
        [
          `${key}:`,
          h.input([
            h.Placeholder(paramType(spec)),
            h.Value(
              model.paramValues[node.name]?.[key] ??
                Option.getOrElse(paramDefault(spec), () => ''),
            ),
            h.OnInput(value => UpdatedParam({ lens: node.name, key, value })),
          ]),
        ],
      ),
    ),
  )
}

const cardView = (
  model: Model,
  host: string,
  node: LensNode,
  position: Position,
): Html => {
  const h = html<Message>()
  const isEntry = Option.contains(model.maybeEntry, node.name)
  const selection = Option.fromNullishOr(model.selections[node.name])

  return h.keyed('div')(
    node.name,
    [
      h.Class(clsx('card', { entry: isEntry })),
      h.Style({ left: `${position.x}px`, top: `${position.y}px` }),
    ],
    [
      h.h2(
        [],
        [
          h.span(
            [
              h.Class('title'),
              h.OnPointerDown(
                (
                  _pointerType,
                  button,
                  _screenX,
                  _screenY,
                  _timeStamp,
                  clientX,
                  clientY,
                ) =>
                  button === 0
                    ? Option.some(
                        PressedCardTitle({
                          host,
                          lens: node.name,
                          clientX,
                          clientY,
                        }),
                      )
                    : Option.none(),
              ),
            ],
            [node.shortname],
          ),
          h.span(
            [
              h.Class('set-entry'),
              h.OnClick(ClickedSetEntry({ lens: node.name })),
            ],
            ['entry'],
          ),
        ],
      ),
      h.div(
        [h.Class('rows')],
        Array.map(node.rows, row =>
          M.value(row).pipe(
            M.tagsExhaustive({
              FieldRow: fieldRow =>
                fieldRowView(model, node, selection, fieldRow),
              EdgeRow: edgeRow => edgeRowView(model, node, selection, edgeRow),
              GroupRow: groupRowView,
            }),
          ),
        ),
      ),
      paramsView(model, node),
    ],
  )
}

/** A stand-in card for a lens on another site (or missing from the catalog). */
const portalView = (node: LensNode, position: Position): Html => {
  const h = html<Message>()
  return h.keyed('div')(
    node.name,
    [
      h.Class(clsx('card portal', { ghost: node.isGhost })),
      h.Style({ left: `${position.x}px`, top: `${position.y}px` }),
    ],
    [
      h.h2(
        [],
        [
          h.a([h.Href(siteRouter({ host: node.host }))], [node.shortname]),
          h.span([h.Style({ color: 'var(--dim)' })], ['↗']),
        ],
      ),
      h.div(
        [h.Class('host')],
        [node.host + (node.isGhost ? ' · not in catalog' : '')],
      ),
    ],
  )
}

const edgesView = (model: Model, nodes: Nodes, host: string): Html => {
  const h = html<Message>()
  return h.svg(
    [h.Class('edges')],
    Array.map(edgeLines(nodes, model.selections, model.positions, host), line =>
      M.value(line.kind).pipe(
        M.withReturnType<Html>(),
        M.when('Follow', () =>
          h.path(
            [
              h.D(line.d),
              h.Fill('none'),
              h.Stroke(line.isFollowed ? 'var(--edge-on)' : 'var(--edge)'),
              h.StrokeWidth(line.isFollowed ? '2' : '1.2'),
              ...(line.isFollowed ? [] : [h.StrokeDasharray('4 3')]),
            ],
            [],
          ),
        ),
        M.when('Outcome', () =>
          h.path(
            [
              h.D(line.d),
              h.Fill('none'),
              h.Stroke('var(--warn)'),
              h.StrokeWidth('1'),
              h.StrokeDasharray('2 4'),
            ],
            [],
          ),
        ),
        M.exhaustive,
      ),
    ),
  )
}

const canvasView = (model: Model, nodes: Nodes, host: string): Html => {
  const h = html<Message>()
  const byName = model.positions[host] ?? {}
  const positionOf = (name: string) => byName[name] ?? { x: 40, y: 64 }

  return h.div(
    [h.Class('canvas-inner')],
    [
      h.div(
        [h.Class('crumb'), h.Style({ position: 'absolute' })],
        [
          h.a([h.Href(sitesRouter())], ['sites']),
          ' / ',
          h.span([h.Class('here')], [host]),
        ],
      ),
      edgesView(model, nodes, host),
      ...Array.map(cardNodes(nodes, host), node =>
        cardView(model, host, node, positionOf(node.name)),
      ),
      ...Array.map(portalNodes(nodes, host), node =>
        portalView(node, positionOf(node.name)),
      ),
    ],
  )
}

export const siteGraphView = (model: Model, host: string): Html => {
  const h = html<Message>()

  return AsyncData.match(model.catalog, {
    onIdle: () => h.div([h.Class('crumb')], ['loading catalog…']),
    onLoading: () => h.div([h.Class('crumb')], ['loading catalog…']),
    onRefreshing: nodes => canvasView(model, nodes, host),
    onSuccess: nodes => canvasView(model, nodes, host),
    onStale: ({ data }) => canvasView(model, data, host),
    onFailure: error =>
      h.div([h.Class('crumb')], [`failed to load catalog: ${error}`]),
  })
}
