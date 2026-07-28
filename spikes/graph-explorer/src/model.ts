import { Schema as S } from 'effect'
import { AsyncData } from 'foldkit'

import { Nodes } from './domain/catalog'
import { Positions } from './domain/layout'
import { ParamValues, Selections } from './domain/select'
import { ResultView } from './message'
import { AppRoute } from './route'

export const CatalogAsyncData = AsyncData.Schema(Nodes, S.String)
export const RunAsyncData = AsyncData.Schema(S.Unknown, S.String)

export const Drag = S.Struct({
  host: S.String,
  lens: S.String,
  startClientX: S.Number,
  startClientY: S.Number,
  startCardX: S.Number,
  startCardY: S.Number,
})
export type Drag = typeof Drag.Type

export const PaneResize = S.Struct({
  startClientX: S.Number,
  startWidth: S.Number,
})
export type PaneResize = typeof PaneResize.Type

export const Model = S.Struct({
  route: AppRoute,
  catalog: CatalogAsyncData.schema,
  selections: Selections,
  paramValues: ParamValues,
  /** Entry override from the "entry" button; honoured only while that lens has ticks. */
  maybePreferredEntry: S.Option(S.String),
  positions: Positions,
  maybeDrag: S.Option(Drag),
  run: RunAsyncData.schema,
  resultView: ResultView,
  resultPaneWidth: S.Number,
  maybePaneResize: S.Option(PaneResize),
})
export type Model = typeof Model.Type
