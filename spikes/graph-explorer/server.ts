/**
 * Graph explorer API. Serves the static lens graph and runs a selection
 * ("tick fields across the graph") as a plan of lens calls.
 *
 * The UI is a Foldkit app served by Vite, which proxies /api here:
 *
 *   bun run api   # this server, port 4380
 *   bun run dev   # vite dev server
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// The dist build, not src: a src-running client stamps the broker from src/
// while the MCP server configured in this machine stamps it from dist/, and
// the two stamps can never agree — each side then kills the other's broker.
import { createLensClient } from '../../packages/client/dist/index.js'

const root = resolve(import.meta.dir, '../..')
const examplesDir = join(root, 'examples')
const port = Number(process.env.PORT ?? 4380)

let clientPromise: ReturnType<typeof createLensClient> | undefined
function client() {
  clientPromise ??= createLensClient({ catalog: [examplesDir] })
  return clientPromise
}

interface Follow {
  /** dot path to the $lens ref field, e.g. "stories.item_url" */
  path: string
  /** max refs to expand when the path crosses an array */
  limit: number
  select: Select
}

interface Select {
  lens: string
  params?: Record<string, unknown>
  fields: string[]
  follows: Follow[]
}

async function loadCatalog() {
  const files = (await readdir(examplesDir)).filter(
    f => f.endsWith('.json') && f !== 'catalog.json',
  )
  const docs = []
  for (const f of files)
    docs.push(JSON.parse(await readFile(join(examplesDir, f), 'utf8')))
  return docs
}

async function runSelect(select: Select): Promise<unknown> {
  const lenses = await client()
  let result
  try {
    result = await lenses.call({
      lens: select.lens,
      params: select.params ?? {},
      strict: false,
    })
  } catch (err) {
    return { $error: err instanceof Error ? err.message : String(err) }
  }
  if (result.kind === 'outcome')
    return { $outcome: result.name, hint: (result as any).hint }
  if (result.kind === 'error')
    return { $error: (result as any).message ?? 'lens error' }

  const keep = select.fields.concat(select.follows.map(f => f.path))
  let value = project(result.value, keep)
  for (const follow of select.follows) {
    const budget = { left: follow.limit }
    value = await expand(value, follow.path.split('.'), follow, budget)
  }
  return value
}

/** Keep only the selected dot paths; untouched branches pass through whole. */
function project(value: unknown, paths: string[]): unknown {
  const tree: Record<string, any> = {}
  for (const p of paths) {
    let t = tree
    for (const seg of p.split('.')) t = t[seg] ??= {}
  }
  return projectTree(value, tree)
}

function projectTree(value: unknown, tree: Record<string, any>): unknown {
  if (Object.keys(tree).length === 0) return value
  if (Array.isArray(value)) return value.map(row => projectTree(row, tree))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, sub] of Object.entries(tree)) {
      if (key in (value as any))
        out[key] = projectTree((value as any)[key], sub)
    }
    return out
  }
  return value
}

/** Replace {$lens, params} refs at `path` with the sub-select's result, up to the budget. */
async function expand(
  value: unknown,
  path: string[],
  follow: Follow,
  budget: { left: number },
): Promise<unknown> {
  if (Array.isArray(value)) {
    const out = []
    for (const row of value) out.push(await expand(row, path, follow, budget))
    return out
  }
  if (!value || typeof value !== 'object') return value
  const obj = value as Record<string, unknown>
  const [head, ...rest] = path
  if (!(head in obj)) return value
  if (rest.length > 0)
    return { ...obj, [head]: await expand(obj[head], rest, follow, budget) }

  const ref = obj[head]
  if (!ref || typeof ref !== 'object' || !('$lens' in (ref as any)))
    return value
  if (budget.left <= 0) return value // unexpanded refs stay visible as {$lens, params}
  budget.left -= 1
  const sub = await runSelect({
    ...follow.select,
    lens: (ref as any).$lens,
    params: (ref as any).params ?? {},
  })
  return { ...obj, [head]: sub }
}

Bun.serve({
  port,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/api/catalog') {
      return Response.json(await loadCatalog())
    }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const select = (await req.json()) as Select
      return Response.json({ data: await runSelect(select) })
    }
    return new Response('not found', { status: 404 })
  },
})

console.log(`graph explorer at http://localhost:${port}`)
