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
import { Nodes } from './domain/catalog'
import { initialPositions } from './domain/layout'
import { collectSamples } from './domain/result'
import {
  Select,
  estimateCalls,
  planFor,
  setFollowLimit,
  toggleField,
  toggleFollow,
} from './domain/select'
import { Message } from './message'
import { CatalogAsyncData, Model, RunAsyncData } from './model'
import { urlToAppRoute } from './route'
import { siteGraphView } from './view/graph'
import { queryPaneView, resultPaneView } from './view/panes'
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
    maybeEntry: Option.none(),
    positions: {},
    maybeDrag: Option.none(),
    run: RunAsyncData.Idle(),
    samples: {},
    resultView: 'JoinTable',
  },
  [FetchCatalog()],
]

// DERIVED STATE

const catalogNodes = (model: Model): Option.Option<Nodes> =>
  AsyncData.match(model.catalog, {
    onIdle: () => Option.none(),
    onLoading: () => Option.none(),
    onFailure: () => Option.none(),
    onRefreshing: nodes => Option.some(nodes),
    onSuccess: nodes => Option.some(nodes),
    onStale: ({ data }) => Option.some(data),
  })

const currentPlan = (model: Model): Option.Option<Select> =>
  Option.flatMap(catalogNodes(model), nodes =>
    planFor(nodes, model.selections, model.paramValues, model.maybeEntry),
  )

// UPDATE

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>]
const withUpdateReturn = M.withReturnType<UpdateReturn>()

const entryFallback = (model: Model, lens: string) =>
  Option.orElse(model.maybeEntry, () => Option.some(lens))

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
          maybeEntry: () => entryFallback(model, lens),
        }),
        [],
      ],

      ToggledFollow: ({ lens, path }) => [
        evo(model, {
          selections: () => toggleFollow(model.selections, lens, path),
          maybeEntry: () => entryFallback(model, lens),
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
        evo(model, { maybeEntry: () => Option.some(lens) }),
        [],
      ],

      ClickedClear: () => [
        evo(model, {
          selections: () => ({}),
          maybeEntry: () => Option.none(),
          run: () => RunAsyncData.Idle(),
          samples: () => ({}),
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
        evo(model, {
          run: () => RunAsyncData.Success({ data }),
          samples: () =>
            Option.match(currentPlan(model), {
              onNone: () => model.samples,
              onSome: select => collectSamples(select, data),
            }),
        }),
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

      MovedPointer: ({ clientX, clientY }) =>
        Option.match(model.maybeDrag, {
          onNone: () => [model, []] as const,
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
        }),

      ReleasedPointer: () => [
        evo(model, { maybeDrag: () => Option.none() }),
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

  const maybePlan = pipe(
    Option.all({ nodes: catalogNodes(model), select: currentPlan(model) }),
    Option.map(({ nodes, select }) => ({
      select,
      estimatedCalls: estimateCalls(nodes, select),
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
