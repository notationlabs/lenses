import { Option } from 'effect'

import { buildNodes } from './domain/catalog'
import { CatalogAsyncData, Model, RunAsyncData } from './model'
import { SiteRoute, SitesRoute } from './route'

export const storiesDoc = {
  name: 'news/stories',
  url: 'https://news.example.com/',
  params: { page: { type: 'integer', default: 1 } },
  returns: {
    type: 'array',
    items: {
      title: 'string',
      points: 'integer',
      item: { $lens: 'news/item', params: { id: 'id' } },
    },
  },
}

export const itemDoc = {
  name: 'news/item',
  url: 'https://news.example.com/item/{id}',
  params: { id: 'string' },
  returns: { type: 'object', fields: { title: 'string', text: 'string' } },
}

export const catalogNodes = buildNodes([storiesDoc, itemDoc])

export const loadingModel: Model = {
  route: SitesRoute(),
  catalog: CatalogAsyncData.Loading(),
  selections: {},
  paramValues: {},
  maybeEntry: Option.none(),
  positions: {},
  maybeDrag: Option.none(),
  run: RunAsyncData.Idle(),
  samples: {},
  resultView: 'JoinTable',
}

export const loadedModel: Model = {
  ...loadingModel,
  catalog: CatalogAsyncData.Success({ data: catalogNodes }),
}

export const siteModel: Model = {
  ...loadedModel,
  route: SiteRoute({ host: 'news.example.com' }),
}
