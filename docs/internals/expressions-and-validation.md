# Expression Checker

Notation Lenses compiles and evaluates JSONata expressions against an `undefined` input context in `expr.ts`. Because no implicit input document exists, bare paths such as `title` yield nothing at runtime unless caught statically by `expr-check.ts`.

## Zero-input evaluation and helper cache

`evaluate` binds site variables (`RESERVED_VARIABLES`) alongside declared `helpers` into JSONata's variable scope and evaluates against `undefined`.

`evaluateBool` applies JSONata boolean semantics, treating empty arrays, empty objects, and lambda objects as false.

Helper lambdas declared under `helpers` are compiled once per unique expression string and memoised in `helperCache`. Keying by source avoids recompiling lambdas across rows while ensuring redefined helpers never collide.

## AST walking and rooted paths

`checkExpression` parses the JSONata AST, collects expression-local bindings via `collectLocals` (assignments, lambda arguments, focus, and index variables), and walks nodes starting with `relative` set to false:

| Walk mode | Permitted paths and symbols |
| :--- | :--- |
| `relative === false` | Variables in `site.vars`, locals, `site.helpers`, and 65 whitelisted `BUILTINS` |
| `relative === true` | Unrooted field names, `$`, `*`, `**`, and `%` inside step sub-expressions |

At `relative === false`, bare field names and unrooted symbols like `$`, `*`, and `**` fail validation because there is no root context.

Once a path begins at an allowed variable, subsequent steps, predicates, map stages, sort terms, transform clauses, and group clauses flip `relative` to true so row fields remain valid. Lambda bodies retain the `relative` flag of their definition site.

## Forward-reference checks in sources

In chained HTTP and intercept `sources`, `checkVariablePath` checks parameter reads against declared parameters and `$sources` reads against `site.sources`, which holds only previously declared sources. Referencing a later or current source fails validation with an explicit ordering error rather than silently reading undefined.

## URL, pattern, and template holes

`checkTemplate` scans `{...}` holes against `HOLE`, rejecting unprefixed holes, nested parameter paths (`{params.a.b}`), and forward source references. At runtime, three helpers expand validated templates with different escaping rules:

| Helper | Escaping behavior |
| :--- | :--- |
| `expandUrl` | Encodes each scalar hole with `encodeURIComponent` |
| `expandRequestPattern` | Encodes with `encodeURIComponent` and escapes `*` as `%2A` |
| `expandTemplate` | Substitutes scalar holes verbatim for selectors, `ready`, and headers |

Escaping `*` as `%2A` in `expandRequestPattern` guarantees a caller-supplied parameter value can never widen an intercept glob to match unintended requests.
