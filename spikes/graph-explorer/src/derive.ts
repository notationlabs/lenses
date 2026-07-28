import { Match as M, Option, pipe } from 'effect'
import { AsyncData } from 'foldkit'

import { Nodes } from './domain/catalog'
import { Samples, collectSamples } from './domain/result'
import { Select, entryFor, planFor } from './domain/select'
import { Model } from './model'

// Everything the checkbox interaction produces — the entry, the plan, the
// sample annotations — is derived here from selections plus the last run.

export const catalogNodes = (model: Model): Option.Option<Nodes> =>
  AsyncData.match(model.catalog, {
    onIdle: () => Option.none(),
    onLoading: () => Option.none(),
    onFailure: () => Option.none(),
    onRefreshing: nodes => Option.some(nodes),
    onSuccess: nodes => Option.some(nodes),
    onStale: ({ data }) => Option.some(data),
  })

/** The host being viewed; ticks there take precedence when rooting the plan. */
const routeHost = (model: Model): Option.Option<string> =>
  M.value(model.route).pipe(
    M.tagsExhaustive({
      Sites: () => Option.none<string>(),
      Site: ({ host }) => Option.some(host),
      NotFound: () => Option.none<string>(),
    }),
  )

export const currentEntry = (model: Model): Option.Option<string> =>
  Option.flatMap(catalogNodes(model), nodes =>
    entryFor(
      nodes,
      model.selections,
      model.maybePreferredEntry,
      routeHost(model),
    ),
  )

export const currentPlan = (model: Model): Option.Option<Select> =>
  Option.flatMap(catalogNodes(model), nodes =>
    planFor(
      nodes,
      model.selections,
      model.paramValues,
      model.maybePreferredEntry,
      routeHost(model),
    ),
  )

const runData = (model: Model): Option.Option<unknown> =>
  AsyncData.match(model.run, {
    onIdle: () => Option.none(),
    onLoading: () => Option.none(),
    onFailure: () => Option.none(),
    onRefreshing: data => Option.some(data),
    onSuccess: data => Option.some(data),
    onStale: ({ data }) => Option.some(data),
  })

/** Samples follow the current ticks against the last run's data: untick a
 * field and its sample goes; tick a new one and it stays blank until rerun. */
export const currentSamples = (model: Model): Samples =>
  pipe(
    Option.all({ select: currentPlan(model), data: runData(model) }),
    Option.match({
      onNone: (): Samples => ({}),
      onSome: ({ select, data }) => collectSamples(select, data),
    }),
  )
