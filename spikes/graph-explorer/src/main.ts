import { Match as M, Number, Option, pipe } from 'effect'
import { AsyncData, Command, Runtime } from 'foldkit'
import { Document, Html, html } from 'foldkit/html'
import { evo } from 'foldkit/struct'
import { Url, toString as urlToString } from 'foldkit/url'

import {
  FetchCatalog,
  LoadExternal,
  NavigateInternal,
  RunSelect,
} from './command'
import { catalogNodes, currentPlan } from './derive'
import { initialPositions } from './domain/layout'
import {
  estimateCalls,
  setFollowLimit,
  toggleField,
  toggleFollow,
  unreachedLenses,
} from './domain/select'
import { Message } from './message'
import { CatalogAsyncData, Model, RunAsyncData } from './model'
import { urlToAppRoute } from './route'
import { siteGraphView } from './view/graph'
import { Plan, queryPaneView, resultPaneView } from './view/panes'
import { sitesIndexView } from './view/sites'

export { Message } from './message'
export { Model } from './model'

// INIT

export const init: Runtime.RoutingApplicationInit<Model, Message> = (
  url: Url,
) => [
  {
    route: urlToAppRoute(url),
    catalog: CatalogAsyncData.Loading(),
    selections: {},
    paramValues: {},
    maybePreferredEntry: Option.none(),
    positions: {},
    maybeDrag: Option.none(),
    run: RunAsyncData.Idle(),
    resultView: 'JoinTable',
    resultPaneWidth: 620,
    maybePaneResize: Option.none(),
  },
  [FetchCatalog()],
]

// UPDATE

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>]
const withUpdateReturn = M.withReturnType<UpdateReturn>()

const clampPaneWidth = (width: number): number =>
  Math.min(Math.max(width, 320), 1200)

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    withUpdateReturn,
    M.tagsExhaustive({
      CompletedNavigateInternal: () => [model, []],
      CompletedLoadExternal: () => [model, []],

      ClickedLink: ({ request }) =>
        M.value(request).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            Internal: ({ url }) => [
              model,
              [NavigateInternal({ url: urlToString(url) })],
            ],
            External: ({ href }) => [model, [LoadExternal({ href })]],
          }),
        ),

      ChangedUrl: ({ url }) => [
        evo(model, { route: () => urlToAppRoute(url) }),
        [],
      ],

      SucceededFetchCatalog: ({ nodes }) => [
        evo(model, {
          catalog: () => CatalogAsyncData.Success({ data: nodes }),
          positions: () => initialPositions(nodes),
        }),
        [],
      ],

      FailedFetchCatalog: ({ error }) => [
        evo(model, { catalog: () => CatalogAsyncData.Failure({ error }) }),
        [],
      ],

      ToggledField: ({ lens, path }) => [
        evo(model, {
          selections: () => toggleField(model.selections, lens, path),
        }),
        [],
      ],

      ToggledFollow: ({ lens, path }) => [
        evo(model, {
          selections: () => toggleFollow(model.selections, lens, path),
        }),
        [],
      ],

      UpdatedFollowLimit: ({ lens, path, value }) =>
        pipe(
          Number.parse(value),
          Option.match({
            onNone: () => [model, []] as const,
            onSome: limit => [
              evo(model, {
                selections: () =>
                  setFollowLimit(model.selections, lens, path, limit),
              }),
              [],
            ],
          }),
        ),

      UpdatedParam: ({ lens, key, value }) => [
        evo(model, {
          paramValues: () => ({
            ...model.paramValues,
            [lens]: { ...model.paramValues[lens], [key]: value },
          }),
        }),
        [],
      ],

      ClickedSetEntry: ({ lens }) => [
        evo(model, { maybePreferredEntry: () => Option.some(lens) }),
        [],
      ],

      ClickedClear: () => [
        evo(model, {
          selections: () => ({}),
          maybePreferredEntry: () => Option.none(),
          run: () => RunAsyncData.Idle(),
        }),
        [],
      ],

      ClickedRun: () => {
        if (AsyncData.isPending(model.run)) {
          return [model, []]
        }
        return Option.match(currentPlan(model), {
          onNone: () => [model, []] as const,
          onSome: select => [
            evo(model, { run: () => RunAsyncData.Loading() }),
            [RunSelect({ select })],
          ],
        })
      },

      SucceededRunSelect: ({ data }) => [
        evo(model, { run: () => RunAsyncData.Success({ data }) }),
        [],
      ],

      FailedRunSelect: ({ error }) => [
        evo(model, { run: () => RunAsyncData.Failure({ error }) }),
        [],
      ],

      SelectedResultView: ({ view: resultView }) => [
        evo(model, { resultView: () => resultView }),
        [],
      ],

      PressedCardTitle: ({ host, lens, clientX, clientY }) =>
        pipe(
          Option.fromNullishOr(model.positions[host]?.[lens]),
          Option.match({
            onNone: () => [model, []] as const,
            onSome: position => [
              evo(model, {
                maybeDrag: () =>
                  Option.some({
                    host,
                    lens,
                    startClientX: clientX,
                    startClientY: clientY,
                    startCardX: position.x,
                    startCardY: position.y,
                  }),
              }),
              [],
            ],
          }),
        ),

      PressedPaneDivider: ({ clientX }) => [
        evo(model, {
          maybePaneResize: () =>
            Option.some({
              startClientX: clientX,
              startWidth: model.resultPaneWidth,
            }),
        }),
        [],
      ],

      MovedPointer: ({ clientX, clientY }) =>
        Option.match(model.maybeDrag, {
          onSome: drag => [
            evo(model, {
              positions: () => ({
                ...model.positions,
                [drag.host]: {
                  ...model.positions[drag.host],
                  [drag.lens]: {
                    x: drag.startCardX + clientX - drag.startClientX,
                    y: drag.startCardY + clientY - drag.startClientY,
                  },
                },
              }),
            }),
            [],
          ],
          onNone: () =>
            Option.match(model.maybePaneResize, {
              onNone: () => [model, []] as const,
              onSome: resize => [
                evo(model, {
                  // the divider sits on the pane's left edge, so dragging left widens it
                  resultPaneWidth: () =>
                    clampPaneWidth(
                      resize.startWidth + resize.startClientX - clientX,
                    ),
                }),
                [],
              ],
            }),
        }),

      ReleasedPointer: () => [
        evo(model, {
          maybeDrag: () => Option.none(),
          maybePaneResize: () => Option.none(),
        }),
        [],
      ],
    }),
  )

// VIEW

const routeContentView = (model: Model): Html => {
  const h = html<Message>()
  return M.value(model.route).pipe(
    M.tagsExhaustive({
      Sites: () => sitesIndexView(model),
      Site: ({ host }) => siteGraphView(model, host),
      NotFound: ({ path }) =>
        h.div([h.Class('crumb')], [`unknown page: ${path}`]),
    }),
  )
}

export const view = (model: Model): Document => {
  const h = html<Message>()

  const maybePlan: Option.Option<Plan> = pipe(
    Option.all({ nodes: catalogNodes(model), select: currentPlan(model) }),
    Option.map(({ nodes, select }) => ({
      select,
      estimatedCalls: estimateCalls(nodes, select),
      unreached: unreachedLenses(model.selections, select),
    })),
  )

  return {
    title: 'lens explorer',
    body: h.div(
      [h.Class('app')],
      [
        h.div([h.Class('main')], [routeContentView(model)]),
        queryPaneView(model, maybePlan),
        resultPaneView(model),
      ],
    ),
  }
}
