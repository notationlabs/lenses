/**
 * GraphQL over lenses. The catalog compiles to a schema (schema.ts); lenses
 * are the resolvers. GraphiQL is served at / and the endpoint is /graphql:
 *
 *   bun start   # http://localhost:4381
 *
 * Queries drive real lens calls (tabs open in your Chrome), so select only
 * what you need and use `first` on array fields to bound ref expansion.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { graphql } from 'graphql'

// The dist build, not src: a src-running client stamps the broker from src/
// while the MCP server configured in this machine stamps it from dist/, and
// the two stamps can never agree — each side then kills the other's broker.
import { createLensClient } from '../../packages/client/dist/index.js'

import { buildSchema } from './schema.ts'

const root = resolve(import.meta.dir, '../..')
const catalogDir = process.env.CATALOG_DIR
  ? resolve(process.env.CATALOG_DIR)
  : join(root, 'examples')
const port = Number(process.env.PORT ?? 4381)

let clientPromise: ReturnType<typeof createLensClient> | undefined
function client() {
  clientPromise ??= createLensClient({ catalog: [catalogDir] })
  return clientPromise
}

async function loadCatalog() {
  const files = (await readdir(catalogDir)).filter(
    f => f.endsWith('.json') && f !== 'catalog.json',
  )
  const docs = []
  for (const f of files)
    docs.push(JSON.parse(await readFile(join(catalogDir, f), 'utf8')))
  return docs
}

const schema = buildSchema(await loadCatalog())

const DEFAULT_QUERY = `# Lenses compiled to GraphQL: sites are entities, lenses their
# fields, and each ref field a lens call made only if you select into it.
{
  hn {
    top(page: 1) {
      stories(first: 3) {
        title
        score
        item {
          story { title }
          comments(first: 2) { author text }
        }
      }
    }
  }
}
`

const graphiqlHtml = `<!doctype html>
<html>
  <head>
    <title>graphql over lenses</title>
    <style>body { margin: 0 } #graphiql { height: 100vh }</style>
    <link rel="stylesheet" href="https://unpkg.com/graphiql@3/graphiql.min.css" />
  </head>
  <body>
    <div id="graphiql">loading…</div>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/graphiql@3/graphiql.min.js"></script>
    <script>
      ReactDOM.createRoot(document.getElementById('graphiql')).render(
        React.createElement(GraphiQL, {
          fetcher: GraphiQL.createFetcher({ url: '/graphql' }),
          defaultQuery: ${JSON.stringify(DEFAULT_QUERY)},
        }),
      )
    </script>
  </body>
</html>`

Bun.serve({
  port,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/') {
      return new Response(graphiqlHtml, {
        headers: { 'content-type': 'text/html' },
      })
    }
    if (url.pathname === '/graphql' && req.method === 'POST') {
      const body = (await req.json()) as {
        query?: string
        variables?: Record<string, unknown>
        operationName?: string
      }
      if (typeof body.query !== 'string') {
        return Response.json({ errors: [{ message: 'no query' }] }, { status: 400 })
      }
      const result = await graphql({
        schema,
        source: body.query,
        variableValues: body.variables,
        operationName: body.operationName,
        contextValue: { client: await client() },
      })
      return Response.json(result)
    }
    return new Response('not found', { status: 404 })
  },
})

console.log(`graphql over lenses at http://localhost:${port}`)
