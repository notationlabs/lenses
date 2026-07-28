import { Effect, Schema as S } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { Command, Http } from 'foldkit'
import { load, pushUrl } from 'foldkit/navigation'

import { buildNodes } from './domain/catalog'
import {
  CompletedLoadExternal,
  CompletedNavigateInternal,
  FailedFetchCatalog,
  FailedRunSelect,
  SucceededFetchCatalog,
  SucceededRunSelect,
} from './message'

export const NavigateInternal = Command.define(
  'NavigateInternal',
  { url: S.String },
  CompletedNavigateInternal,
)(({ url }) => pushUrl(url).pipe(Effect.as(CompletedNavigateInternal())))

export const LoadExternal = Command.define(
  'LoadExternal',
  { href: S.String },
  CompletedLoadExternal,
)(({ href }) => load(href).pipe(Effect.as(CompletedLoadExternal())))

export const fetchCatalogEffect = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(HttpClientRequest.get('/api/catalog'))
  if (response.status !== 200) {
    return yield* Effect.fail(
      FailedFetchCatalog({
        error: `catalog request failed (${response.status})`,
      }),
    )
  }
  const docs = yield* response.json
  if (!Array.isArray(docs)) {
    return yield* Effect.fail(
      FailedFetchCatalog({ error: 'catalog response is not an array' }),
    )
  }
  return SucceededFetchCatalog({ nodes: buildNodes(docs) })
}).pipe(
  Effect.catchTag('FailedFetchCatalog', error => Effect.succeed(error)),
  Effect.catch(() =>
    Effect.succeed(
      FailedFetchCatalog({ error: 'failed to load the lens catalog' }),
    ),
  ),
)

export const FetchCatalog = Command.define(
  'FetchCatalog',
  SucceededFetchCatalog,
  FailedFetchCatalog,
)(Effect.provide(fetchCatalogEffect, Http.layer))

export const runSelectEffect = (select: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post('/api/run').pipe(
      HttpClientRequest.bodyJsonUnsafe(select),
    )
    const response = yield* client.execute(request)
    if (response.status !== 200) {
      return yield* Effect.fail(
        FailedRunSelect({ error: `run request failed (${response.status})` }),
      )
    }
    const body = yield* response.json
    const data =
      typeof body === 'object' && body !== null && 'data' in body
        ? body.data
        : undefined
    if (data === undefined) {
      return yield* Effect.fail(
        FailedRunSelect({ error: 'run response has no data' }),
      )
    }
    return SucceededRunSelect({ data })
  }).pipe(
    Effect.catchTag('FailedRunSelect', error => Effect.succeed(error)),
    Effect.catch(() =>
      Effect.succeed(FailedRunSelect({ error: 'run failed' })),
    ),
  )

export const RunSelect = Command.define(
  'RunSelect',
  { select: S.Unknown },
  SucceededRunSelect,
  FailedRunSelect,
)(({ select }) => Effect.provide(runSelectEffect(select), Http.layer))
