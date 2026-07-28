import { Schema as S } from 'effect'
import { m } from 'foldkit/message'
import { UrlRequest } from 'foldkit/navigation'
import { Url } from 'foldkit/url'

import { Nodes } from './domain/catalog'

export const ResultView = S.Literals(['JoinTable', 'Tree'])
export type ResultView = typeof ResultView.Type

export const ClickedLink = m('ClickedLink', { request: UrlRequest })
export const ChangedUrl = m('ChangedUrl', { url: Url })
export const CompletedNavigateInternal = m('CompletedNavigateInternal')
export const CompletedLoadExternal = m('CompletedLoadExternal')
export const SucceededFetchCatalog = m('SucceededFetchCatalog', {
  nodes: Nodes,
})
export const FailedFetchCatalog = m('FailedFetchCatalog', { error: S.String })
export const ToggledField = m('ToggledField', {
  lens: S.String,
  path: S.String,
})
export const ToggledFollow = m('ToggledFollow', {
  lens: S.String,
  path: S.String,
})
export const UpdatedFollowLimit = m('UpdatedFollowLimit', {
  lens: S.String,
  path: S.String,
  value: S.String,
})
export const UpdatedParam = m('UpdatedParam', {
  lens: S.String,
  key: S.String,
  value: S.String,
})
export const ClickedSetEntry = m('ClickedSetEntry', { lens: S.String })
export const ClickedClear = m('ClickedClear')
export const ClickedRun = m('ClickedRun')
export const SucceededRunSelect = m('SucceededRunSelect', { data: S.Unknown })
export const FailedRunSelect = m('FailedRunSelect', { error: S.String })
export const SelectedResultView = m('SelectedResultView', { view: ResultView })
export const PressedCardTitle = m('PressedCardTitle', {
  host: S.String,
  lens: S.String,
  clientX: S.Number,
  clientY: S.Number,
})
export const PressedPaneDivider = m('PressedPaneDivider', {
  clientX: S.Number,
})
export const MovedPointer = m('MovedPointer', {
  clientX: S.Number,
  clientY: S.Number,
})
export const ReleasedPointer = m('ReleasedPointer')

export const Message = S.Union([
  ClickedLink,
  ChangedUrl,
  CompletedNavigateInternal,
  CompletedLoadExternal,
  SucceededFetchCatalog,
  FailedFetchCatalog,
  ToggledField,
  ToggledFollow,
  UpdatedFollowLimit,
  UpdatedParam,
  ClickedSetEntry,
  ClickedClear,
  ClickedRun,
  SucceededRunSelect,
  FailedRunSelect,
  SelectedResultView,
  PressedCardTitle,
  PressedPaneDivider,
  MovedPointer,
  ReleasedPointer,
])
export type Message = typeof Message.Type
