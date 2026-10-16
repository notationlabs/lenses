import jsonata from "jsonata";
import { HOLE } from "./url-pattern.js";

/**
 * Static checks for lens expressions and templates.
 *
 * Expressions are evaluated with no input context, so the data an expression
 * reads must be named: a path at the top level of an expression has to start
 * at a variable. Paths *inside* a step — a `[predicate]`, a `.{…}` or `.(…)`
 * after a variable-rooted step, a sort term — are relative to that step's
 * own items and stay legal: in `$value[$has(date)].{ 'd': date }` both `date`s
 * read the current row, not the (absent) input.
 */

/** Variables the engine binds at some expression site. */
export const RESERVED_VARIABLES = ["res", "item", "sources", "params", "value", "page"] as const;
export type ReservedVariable = (typeof RESERVED_VARIABLES)[number];

/** JSONata's built-in functions, which an expression may always call. */
const BUILTINS = new Set([
  "sum", "count", "max", "min", "average", "string", "substring", "substringBefore",
  "substringAfter", "lowercase", "uppercase", "length", "trim", "pad", "match", "contains",
  "replace", "split", "join", "formatNumber", "formatBase", "formatInteger", "parseInteger",
  "number", "floor", "ceil", "round", "abs", "sqrt", "power", "random", "boolean", "not",
  "map", "zip", "filter", "single", "reduce", "sift", "keys", "lookup", "append", "exists",
  "spread", "merge", "reverse", "each", "error", "assert", "type", "sort", "shuffle",
  "distinct", "encodeUrlComponent", "encodeUrl", "decodeUrlComponent", "decodeUrl", "eval",
  "toMillis", "fromMillis", "clone", "now", "millis",
]);

/** What an expression site binds, for checking and for error messages. */
export interface ExprSite {
  /** Human name of the site, e.g. "dom post". */
  label: string;
  /** Reserved variables bound at this site. */
  vars: readonly ReservedVariable[];
  /** Helper names bound as `$name`. */
  helpers?: readonly string[];
  /** Declared parameter names; when given, `$params.x` must name one. */
  params?: readonly string[];
  /** Source names `$sources` holds here; when given, `$sources.x` must name one. */
  sources?: readonly string[];
  /** Every source the tier declares, for a hint when one is read as `$name`. */
  allSources?: readonly string[];
}

type Node = Record<string, unknown> & { type?: string; value?: unknown };

function listVars(vars: readonly string[]): string {
  return vars.length ? vars.map((name) => `$${name}`).join(", ") : "no variables";
}

/**
 * Check one expression for its site. Returns an error message, or undefined
 * when the expression is valid there.
 */
export function checkExpression(expr: string, site: ExprSite): string | undefined {
  let ast: Node;
  try {
    ast = jsonata(expr).ast() as Node;
  } catch (error) {
    const message = (error as { message?: string }).message ?? String(error);
    return `${site.label} expression does not parse: ${message}`;
  }
  const locals = new Set<string>();
  collectLocals(ast, locals);
  const errors: string[] = [];
  walk(ast, false, site, locals, errors);
  return errors[0];
}

/** Every name the expression binds itself: `$x := …`, lambda args, `@$f`, `#$i`. */
function collectLocals(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectLocals(child, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  if (n.type === "bind" && isNode(n.lhs) && n.lhs.type === "variable") out.add(String(n.lhs.value));
  if (n.type === "lambda" && Array.isArray(n.arguments)) {
    for (const arg of n.arguments as Node[]) if (arg.type === "variable") out.add(String(arg.value));
  }
  if (typeof n.focus === "string") out.add(n.focus);
  if (typeof n.index === "string") out.add(n.index);
  for (const [key, child] of Object.entries(n)) {
    if (key !== "position") collectLocals(child, out);
  }
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathText(node: Node): string {
  if (node.type === "path" && Array.isArray(node.steps)) {
    return (node.steps as Node[])
      .map((step) => (step.type === "name" ? String(step.value) : step.type === "variable" ? `$${String(step.value)}` : "…"))
      .join(".");
  }
  return String(node.value ?? "");
}

/**
 * `relative` says whether the node is evaluated against a step's own items
 * (true) or against the expression's absent input (false).
 */
function walk(node: unknown, relative: boolean, site: ExprSite, locals: Set<string>, errors: string[]): void {
  if (errors.length) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, relative, site, locals, errors);
    return;
  }
  if (!isNode(node)) return;
  if (node.type === "path" && Array.isArray(node.steps)) {
    const steps = node.steps as Node[];
    steps.forEach((step, index) => {
      if (index === 0 && !relative && step.type === "name") {
        errors.push(
          `${site.label}: path "${pathText(node)}" must start at a variable (${listVars(site.vars)}); ` +
          `expressions have no implicit input`
        );
        return;
      }
      if (index === 0 && step.type === "variable") checkVariablePath(steps, site, locals, errors);
      walkStep(step, index === 0 ? relative : true, site, locals, errors);
    });
    if (isNode(node.group)) walk(node.group.lhs, true, site, locals, errors);
    return;
  }
  if (node.type === "variable") checkVariablePath([node], site, locals, errors);
  walkStep(node, relative, site, locals, errors);
}

function walkStep(node: Node, relative: boolean, site: ExprSite, locals: Set<string>, errors: string[]): void {
  if (errors.length) return;
  switch (node.type) {
    case "name":
      if (!relative) {
        errors.push(
          `${site.label}: path "${String(node.value)}" must start at a variable (${listVars(site.vars)}); ` +
          `expressions have no implicit input`
        );
      }
      break;
    case "variable":
      if (node.value === "" && !relative) {
        errors.push(
          `${site.label}: "$" has no input to refer to here; name the data with a variable (${listVars(site.vars)})`
        );
      } else if (node.value === "$") {
        errors.push(`${site.label}: "$$" has no input to refer to; name the data with a variable (${listVars(site.vars)})`);
      } else if (node.value !== "") {
        checkVariable(String(node.value), site, locals, errors);
      }
      break;
    case "wildcard":
    case "descendant":
    case "parent":
      if (!relative) {
        errors.push(
          `${site.label}: "${node.type === "wildcard" ? "*" : node.type === "descendant" ? "**" : "%"}" ` +
          `must follow a variable-rooted step (${listVars(site.vars)})`
        );
      }
      break;
    case "unary":
      if (node.value === "{") {
        for (const pair of (node.lhs as unknown[][]) ?? []) walk(pair, relative, site, locals, errors);
      } else if (node.value === "[") {
        walk(node.expressions, relative, site, locals, errors);
      } else {
        walk(node.expression, relative, site, locals, errors);
      }
      break;
    case "binary":
    case "apply":
      walk(node.lhs, relative, site, locals, errors);
      walk(node.rhs, relative, site, locals, errors);
      break;
    case "bind":
      walk(node.rhs, relative, site, locals, errors);
      break;
    case "condition":
      walk(node.condition, relative, site, locals, errors);
      walk(node.then, relative, site, locals, errors);
      walk(node.else, relative, site, locals, errors);
      break;
    case "block":
      walk(node.expressions, relative, site, locals, errors);
      break;
    case "function":
    case "partial":
      walk(node.procedure, relative, site, locals, errors);
      walk(node.arguments, relative, site, locals, errors);
      break;
    case "lambda":
      // A lambda closes over the input where it is defined, so its body has
      // the same (absent) context; its arguments are locals.
      walk(node.body, relative, site, locals, errors);
      break;
    case "sort":
      for (const term of (node.terms as Node[]) ?? []) walk(term.expression, true, site, locals, errors);
      break;
    case "transform":
      walk(node.pattern, true, site, locals, errors);
      walk(node.update, true, site, locals, errors);
      walk(node.delete, true, site, locals, errors);
      break;
    default:
      break;
  }
  // Predicates, filter stages and group-by run against the step's own items.
  for (const key of ["predicate", "stages"] as const) {
    for (const stage of (node[key] as Node[] | undefined) ?? []) {
      if (isNode(stage) && "expr" in stage) walk(stage.expr, true, site, locals, errors);
    }
  }
  if (isNode(node.group)) walk(node.group.lhs, true, site, locals, errors);
}

function checkVariable(name: string, site: ExprSite, locals: Set<string>, errors: string[]): void {
  if ((site.vars as readonly string[]).includes(name)) return;
  if (locals.has(name) || BUILTINS.has(name) || site.helpers?.includes(name)) return;
  if ((RESERVED_VARIABLES as readonly string[]).includes(name)) {
    const note = name === "item" && site.vars.includes("res")
      ? ' (a map binds $item only when its tier declares "items")'
      : "";
    errors.push(`${site.label}: $${name} is not available here; in scope: ${listVars(site.vars)}${note}`);
    return;
  }
  if (site.params?.includes(name) && site.vars.includes("params")) {
    errors.push(`${site.label}: variable "$${name}" is not defined; read the call parameter as $params.${name}`);
    return;
  }
  if ((site.allSources ?? site.sources)?.includes(name) && site.vars.includes("sources")) {
    errors.push(`${site.label}: variable "$${name}" is not defined; read the source as $sources.${name}.body`);
    return;
  }
  errors.push(`${site.label}: variable "$${name}" is not defined (in scope: ${listVars(site.vars)})`);
}

/** `$params.x` and `$sources.x` must name something declared. */
function checkVariablePath(steps: Node[], site: ExprSite, locals: Set<string>, errors: string[]): void {
  const root = String(steps[0].value);
  if (locals.has(root) || errors.length) return;
  const next = steps[1];
  if (!next || next.type !== "name") return;
  const field = String(next.value);
  if (root === "params" && site.params && site.vars.includes("params") && !site.params.includes(field)) {
    errors.push(`${site.label}: $params.${field} names no declared parameter`);
  }
  if (root === "sources" && site.sources && site.vars.includes("sources") && !site.sources.includes(field)) {
    errors.push(
      site.allSources?.includes(field)
        ? `${site.label}: $sources.${field} is not available yet; a source sees only the sources declared before it`
        : `${site.label}: $sources.${field} names no declared source`
    );
  }
}


export interface TemplateSite {
  label: string;
  /** Declared parameter names. */
  params: readonly string[];
  /** Source names a hole may read; absent where sources are not in scope. */
  sources?: readonly string[];
  allSources?: readonly string[];
}

/** Check a template's holes. Returns an error message or undefined. */
export function checkTemplate(template: string, site: TemplateSite): string | undefined {
  for (const match of template.matchAll(HOLE)) {
    const path = match[1].split(".");
    const [root, name] = path;
    if (path.length === 1) {
      const suggestion = site.params.includes(root)
        ? `{params.${root}}`
        : site.allSources?.includes(root) ? `{sources.${root}}` : `{params.${root}}`;
      return `${site.label}: hole "{${root}}" must name its root; write "${suggestion}"`;
    }
    if (root === "params") {
      if (!site.params.includes(name)) return `${site.label}: parameter "${name}" in "{${match[1]}}" is not declared`;
      if (path.length > 2) return `${site.label}: "{${match[1]}}" reads into a parameter; parameters are scalars`;
      continue;
    }
    if (root === "sources") {
      if (!site.sources) return `${site.label}: "{${match[1]}}" — sources are not in scope here; only {params.name} holes are`;
      if (!site.sources.includes(name)) {
        return site.allSources?.includes(name)
          ? `${site.label}: "{${match[1]}}" reads a source declared after this one`
          : `${site.label}: source "${name}" in "{${match[1]}}" is not declared`;
      }
      continue;
    }
    // A dotted hole whose root is a parameter or source name is the old form.
    if (site.params.includes(root)) return `${site.label}: hole "{${match[1]}}" must start with "params."`;
    if (site.allSources?.includes(root)) {
      return `${site.label}: hole "{${match[1]}}" must start with "sources."; write "{sources.${match[1]}}"`;
    }
    return `${site.label}: hole "{${match[1]}}" must start with ${site.sources ? '"params." or "sources."' : '"params."'}`;
  }
  return undefined;
}
