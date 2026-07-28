/**
 * Compile lens documents into a GraphQL schema.
 *
 * Each lens becomes a Query field whose args are the lens params. Each $lens
 * ref in a returns contract becomes an object field of the target lens's
 * type, resolved by calling the lens client — so refs are only followed when
 * the query selects into them, and array fields take `first` to bound how
 * many rows resolve onward.
 */
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLFieldConfig,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
} from 'graphql'

export interface LensClient {
  call(input: {
    lens: string
    params: Record<string, unknown>
    strict: boolean
  }): Promise<any>
}

export interface Context {
  client: LensClient
}

type Doc = Record<string, any>

/** Untyped or unmapped values pass through as-is. */
const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  serialize: value => value,
})

const SCALARS: Record<string, GraphQLOutputType> = {
  string: GraphQLString,
  integer: GraphQLInt,
  number: GraphQLFloat,
  boolean: GraphQLBoolean,
  null: JSONScalar,
}

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** '@djgrant/hn/top' → ['hn', 'top'] (scope dropped). */
const segmentsOf = (lens: string): string[] =>
  lens
    .replace(/^@[^/]+\//, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(segment => segment !== '')

const capitalise = (word: string): string =>
  word.charAt(0).toUpperCase() + word.slice(1)

async function callLens(
  client: LensClient,
  lens: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.call({ lens, params, strict: false })
  if (result.kind === 'outcome') {
    throw new GraphQLError(`${lens} returned outcome: ${result.name}`, {
      extensions: { lens, outcome: result.name, hint: result.hint },
    })
  }
  if (result.kind === 'error') {
    throw new GraphQLError(result.message ?? `${lens} errored`, {
      extensions: { lens },
    })
  }
  return result.value
}

export function buildSchema(docs: Doc[]): GraphQLSchema {
  const named = docs.filter(doc => isRecord(doc) && typeof doc.name === 'string')
  const typeByLens = new Map<string, GraphQLOutputType>()
  const usedNames = new Set<string>(['Query', 'JSON'])

  const uniqueName = (base: string): string => {
    let name = base
    let n = 2
    while (usedNames.has(name)) name = `${base}${n++}`
    usedNames.add(name)
    return name
  }

  /** A field whose value is a materialised {$lens, params} ref: resolve by calling the lens. */
  const refField = (
    target: string,
    key: string,
  ): GraphQLFieldConfig<any, Context> => ({
    type: typeForLens(target),
    description: `follows the ${target} ref`,
    resolve: async (parent, _args, context) => {
      const ref = parent?.[key]
      if (!isRecord(ref) || typeof ref.$lens !== 'string') return null
      return callLens(context.client, ref.$lens, ref.params ?? {})
    },
  })

  const fieldConfig = (
    schema: unknown,
    key: string,
    owner: string,
  ): GraphQLFieldConfig<any, Context> => {
    if (isRecord(schema) && typeof schema.$lens === 'string') {
      return refField(schema.$lens, key)
    }
    if (isRecord(schema) && schema.type === 'array') {
      const items = schema.items
      // items may be a bare field map (no type/$lens), a schema, or a scalar name
      const itemType =
        isRecord(items) && items.type === undefined && items.$lens === undefined
          ? objectType(`${owner}${capitalise(key)}`, items)
          : typeFor(items, key, owner)
      return {
        type: new GraphQLList(itemType),
        args: {
          first: {
            type: GraphQLInt,
            description: 'bound how many rows resolve onward',
          },
        },
        resolve: (parent, args) => {
          const value = parent?.[key]
          if (!Array.isArray(value)) return value ?? null
          return typeof args.first === 'number'
            ? value.slice(0, args.first)
            : value
        },
      }
    }
    return { type: typeFor(schema, key, owner) }
  }

  const typeFor = (
    schema: unknown,
    key: string,
    owner: string,
  ): GraphQLOutputType => {
    if (typeof schema === 'string') return SCALARS[schema] ?? JSONScalar
    if (!isRecord(schema)) return JSONScalar
    if (typeof schema.$lens === 'string') return typeForLens(schema.$lens)
    if (schema.type === 'object' && isRecord(schema.fields)) {
      return objectType(`${owner}${capitalise(key)}`, schema.fields)
    }
    if (typeof schema.type === 'string') {
      return SCALARS[schema.type] ?? JSONScalar
    }
    return JSONScalar
  }

  const objectType = (
    baseName: string,
    fields: Record<string, unknown>,
  ): GraphQLObjectType<any, Context> => {
    const name = uniqueName(baseName)
    return new GraphQLObjectType<any, Context>({
      name,
      fields: () =>
        Object.fromEntries(
          Object.entries(fields).map(([key, sub]) => [
            key,
            fieldConfig(sub, key, name),
          ]),
        ),
    })
  }

  /** The GraphQL type a lens resolves to; memoised so cyclic refs (next_page) work. */
  const typeForLens = (lens: string): GraphQLOutputType => {
    const existing = typeByLens.get(lens)
    if (existing !== undefined) return existing
    const doc = named.find(candidate => candidate.name === lens)
    const baseName = segmentsOf(lens).map(capitalise).join('')
    const type =
      doc === undefined
        ? JSONScalar // ref into a lens we have no document for
        : (() => {
            const returns = doc.returns
            if (isRecord(returns) && returns.type === 'object') {
              return objectType(baseName, returns.fields ?? {})
            }
            if (isRecord(returns) && returns.type === 'array') {
              const items = returns.items
              return new GraphQLList(
                isRecord(items) &&
                items.type === undefined &&
                items.$lens === undefined
                  ? objectType(`${baseName}Item`, items)
                  : typeFor(items, 'item', baseName),
              )
            }
            return JSONScalar
          })()
    typeByLens.set(lens, type)
    return type
  }

  const argsFor = (params: Record<string, unknown> | undefined) =>
    Object.fromEntries(
      Object.entries(params ?? {}).map(([key, declaration]) => {
        const type = isRecord(declaration) ? declaration.type : declaration
        const fallback = isRecord(declaration) ? declaration.default : undefined
        return [
          key,
          {
            type: SCALARS[String(type)] ?? GraphQLString,
            ...(fallback !== undefined ? { defaultValue: fallback } : {}),
          },
        ]
      }),
    )

  // Register every lens type up front so cross-references bind by name.
  for (const doc of named) typeForLens(doc.name)

  const query = new GraphQLObjectType<unknown, Context>({
    name: 'Query',
    fields: () =>
      Object.fromEntries(
        named.map(doc => [
          segmentsOf(doc.name).join('_'),
          {
            type: typeForLens(doc.name),
            args: argsFor(doc.params),
            description: doc.description,
            resolve: (_source: unknown, args: any, context: Context) =>
              callLens(context.client, doc.name, args),
          },
        ]),
      ),
  })

  return new GraphQLSchema({ query, types: [JSONScalar] })
}
