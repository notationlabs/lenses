# TypeScript SDK

Notation Lenses ships a TypeScript client in `@notation/lenses` for Node.js 22.12 and later. You can call lenses with a plain client or generate fully typed bindings from your catalog.

```sh [Terminal]
npm install @notation/lenses
```

## Creating and disposing a client

Construct a client synchronously with `createLensClient` and pass one or more catalog sources. Lenses binds the browser broker lazily on your first call or observation:

```ts [src/hn.ts]
import { createLensClient } from "@notation/lenses";

await using lenses = createLensClient({ catalog: ["./examples"] });

const result = await lenses.call({ lens: "hn/top", params: { page: 1 } });
if (result.kind === "value") {
  console.log(result.value);
}
```

Use `await using` to close the broker transport automatically when the block exits. Without explicit resource management, call `await lenses.close()` in a `finally` block.

## Calling lenses with call vs value

Lenses offers two methods for running a lens depending on how you want to handle non-value results:

| Method | Return behavior |
| :--- | :--- |
| `call` | Returns a discriminated result union across value, outcome, and error |
| `value` | Returns the resolved value directly and throws on outcomes or errors |

Use `call()` when your control flow branches directly on `result.kind`. Use `value()` when a call must return data to continue and outcomes or errors should raise exceptions.

## Handling outcomes and errors

Calling `value()` throws `LensOutcomeError` when a lens returns a named outcome such as `needs_auth`, or `LensResultError` when a call fails:

```ts [src/usage.ts]
import { LensOutcomeError, LensResultError } from "@notation/lenses";

try {
  const usage = await lenses.value({ lens: "claude/usage" });
  console.log(usage);
} catch (error) {
  if (error instanceof LensOutcomeError && error.outcome === "needs_auth") {
    console.log(error.hint);
  } else if (error instanceof LensResultError) {
    console.error(error.message, error.issues);
  } else {
    throw error;
  }
}
```

`LensOutcomeError` exposes the outcome name, payload, and optional recovery hint:

| Property | Meaning |
| :--- | :--- |
| `outcome` | Declared exception name such as `needs_auth` |
| `value` | Optional outcome payload or follow-up `$lens` reference |
| `hint` | Recovery guidance declared on the lens exception |

`LensResultError` carries `message`, schema validation `issues`, and the broker `callId` when available.

## Generating typed bindings

The plain client types resolved data as `unknown`. Generate TypeScript definitions directly from your catalog's `params` and `returns` schemas:

```sh [Terminal]
lens gen ts-sdk ./examples -o src/lenses.gen.ts
```

The generated file exports a `Lenses` interface keyed by both scoped names and shortnames, along with a typed `createLensClient` wrapper and re-exported error classes:

```ts [src/typed.ts]
import { createLensClient } from "./lenses.gen.js";

await using client = createLensClient({ catalog: ["./examples"] });

const top = await client.value({ lens: "hn/top", params: { page: 2 } });
console.log(top.stories[0].title);
```

Import `createLensClient` from `./lenses.gen.js` rather than `@notation/lenses`, and still pass `catalog` at runtime.

Re-run `lens gen ts-sdk` after editing a lens or running `lens update`, because each run overwrites the file.

## Recording screenshots

Call `record()` to capture PNG screenshots at `bind`, `navigation`, and `final` checkpoints across calls made through that client:

```ts [src/record.ts]
const recording = lenses.record();
await lenses.call({ lens: "claude/usage" });
recording.stop();

console.log(recording.path);
```

By default, Lenses creates a timestamped directory matching `./screenshots/lenses-recording-...` containing deduplicated PNG files and an `index.json` manifest of URLs, titles, and hashes. Pass `{ path: "./artifacts" }` to change the root directory.

Only one recording can run on a client at a time. Call `recording.stop()` before calling `record()` again.

## Observing pages for debugging

Call `observe()` to load a page without a lens and inspect its text snapshot alongside captured network traffic:

```ts [src/observe.ts]
const seen = await lenses.observe({
  target: "https://news.ycombinator.com/news",
  html: true,
});
```

Setting `html: true` includes body HTML with scripts and styles stripped. Each entry in `requests` includes its `index`, HTTP method, URL, status code, and a short preview while eliding full bodies.

To read captured response bodies, call `observe()` again with `request` set to a numeric `index` or URL substring:

```ts [src/observe-body.ts]
const bodies = await lenses.observe({
  target: "https://news.ycombinator.com/news",
  request: 0,
});
```

You can also pass `tab` from an earlier result to inspect an existing browser tab without opening a new one. See [Client Reference](../reference/client.md) for all client methods and options.
