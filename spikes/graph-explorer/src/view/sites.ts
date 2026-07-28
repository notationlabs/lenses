import { Array, Option, Record, pipe } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, html } from 'foldkit/html'

import { currentEntry } from '../derive'
import { LensNode, Nodes, hostsOf, nodesForHost } from '../domain/catalog'
import { Message } from '../message'
import { Model } from '../model'
import { siteRouter } from '../route'

const siteTileView = (
  model: Model,
  host: string,
  local: ReadonlyArray<LensNode>,
): Html => {
  const h = html<Message>()

  const pickedBits = Array.flatMap(local, node => {
    const selection = model.selections[node.name]
    const pickedCount =
      selection === undefined
        ? 0
        : selection.fields.length + Record.size(selection.follows)
    const isEntry = Option.contains(currentEntry(model), node.name)
    return [
      ...(isEntry ? [`entry: ${node.shortname}`] : []),
      ...(pickedCount > 0 ? [`${node.shortname}: ${pickedCount} picked`] : []),
    ]
  })

  return h.keyed('div')(
    host,
    [h.Class('site-tile')],
    [
      h.h2([], [h.a([h.Href(siteRouter({ host }))], [host])]),
      h.div(
        [h.Class('lenses')],
        [
          pipe(
            Array.map(local, node => node.shortname),
            Array.join(' · '),
          ),
        ],
      ),
      Array.match(pickedBits, {
        onEmpty: () => h.empty,
        onNonEmpty: bits => h.div([h.Class('meta')], [Array.join(bits, ' · ')]),
      }),
    ],
  )
}

const siteListView = (model: Model, nodes: Nodes): Html => {
  const h = html<Message>()

  return h.div(
    [h.Class('site-list')],
    Array.map(hostsOf(nodes), host =>
      siteTileView(model, host, nodesForHost(nodes, host)),
    ),
  )
}

export const sitesIndexView = (model: Model): Html => {
  const h = html<Message>()

  const content = AsyncData.match(model.catalog, {
    onIdle: () => h.div([h.Class('crumb')], ['loading catalog…']),
    onLoading: () => h.div([h.Class('crumb')], ['loading catalog…']),
    onRefreshing: nodes => siteListView(model, nodes),
    onSuccess: nodes => siteListView(model, nodes),
    onStale: ({ data }) => siteListView(model, data),
    onFailure: error =>
      h.div([h.Class('crumb')], [`failed to load catalog: ${error}`]),
  })

  return h.div(
    [],
    [
      h.div([h.Class('crumb')], [h.span([h.Class('here')], ['sites'])]),
      content,
    ],
  )
}
