# TypeScript

Call lenses from Node.js 22.12 or later with `@notation/lenses`. `lens gen ts-sdk` generates types for your catalog, so results are typed.

```sh
npm install @notation/lenses
```

## Calling a lens

Call `hn/top` and branch on the result:

```ts
import { createLensClient } from "@notation/lenses";

await using lenses = createLensClient({ catalog: ["./examples"] });

const result = await lenses.call({ lens: "hn/top", params: { page: 1 } });

if (result.kind === "value") {
  console.log(result.value);
} else if (result.kind === "outcome") {
  console.log(result.name, result.hint);
} else {
  console.error(result.message);
}
```

`catalog` is required; [Catalogs](./catalogs.md) lists the kinds of source. `await using` closes the client when the scope ends. Without it, call `await lenses.close()` yourself. [Calling Lenses](./calling.md) explains the three result kinds.

## Adding types

The plain client types `result.value` as `unknown`. The lens document already declares its parameters and result shape, so the CLI can generate the types:

```sh
lens gen ts-sdk ./examples -o src/lenses.gen.ts
```

The generated `Lenses` interface has a `params` and a `result` type for every lens, under both its full name, `@djgrant/hn/top`, and its short name, `hn/top`. The `hn/top` entry, shortened:

```ts
"@djgrant/hn/top": {
  params: { page?: number };                          // ← page has a default, so it is optional
  result: {
    stories: Array<{
      title: string;
      score: string | null;
      item_url: LensRef<"@djgrant/hn/item"> | null;  // ← a follow-up call to hn/item
      [key: string]: unknown;
    }>;
    next_page: LensRef<"@djgrant/hn/top"> | null;
    [key: string]: unknown;
  };
};
```

Run the generator again after you edit a lens or run `lens update`. Each run overwrites the file, so do not edit it by hand.

## Calling with types

Get a typed value with the generated client:

```ts
import { createLensClient, LensOutcomeError, LensResultError } from "./lenses.gen.js";

await using client = createLensClient({ catalog: ["./examples"] });

const top = await client.value({ lens: "hn/top", params: { page: 2 } });
console.log(top.stories[0].title); // ← typed as string
```

Import `createLensClient` from the generated module, not the package. The module does not record its catalog, so you pass it again.

`value()` returns the value directly and throws on anything else. Use it when your code can only continue with data. An outcome throws a `LensOutcomeError` with `outcome` and `hint` properties. An error throws a `LensResultError` with the `message`. `hn/top` works signed out, so this example uses `claude/usage`:

```ts
try {
  const usage = await client.value({ lens: "claude/usage" });
  console.log(usage.plan);
} catch (error) {
  if (error instanceof LensOutcomeError && error.outcome === "needs_auth") {
    console.log(error.hint);
    // "Ask the user to sign in to claude.ai in the open tab, then retry this call."
  } else if (error instanceof LensResultError) {
    console.error(error.message);
  } else {
    throw error;
  }
}
```

To handle outcomes as branches instead of exceptions, use `call()`. It returns the same result object as the plain client, with the `value` branch typed.

The typed client accepts the same call options as the plain client, including `allowWrites` and `tab`.

## Recording a run

Save a screenshot each time the page settles during a call:

```ts
const recording = lenses.record();
await lenses.call({ lens: "claude/usage" });
recording.stop();

console.log(recording.path);
// /Users/you/project/screenshots/lenses-recording-2026-11-03T10-15-02.123Z
```

Each recording gets a new directory under `./screenshots`, or under the root you pass with `record({ path: "./artifacts" })`. It holds numbered PNG files and an `index.json` that lists each screenshot's URL and page title. A client has one recording at a time, so calling `record()` again before `stop()` throws.

## Observing a page

Load a page without a lens, to see what it contains while you write one:

```ts
const seen = await lenses.observe({
  target: "https://news.ycombinator.com/news",
  html: true,
});
```

The result is a `value` with a snapshot of the page and the network requests it made. `html: true` adds the page's HTML, without scripts and styles. The request list gives each request's `index`, `method`, `url` and `status`, but no bodies. To read bodies, observe again with `request` set to an index or part of the URL:

```ts
const bodies = await lenses.observe({
  target: "https://news.ycombinator.com/news",
  request: 0,
});
```

[Writing a Lens](./authoring.md) describes that workflow. The [client reference](../api/client.md) lists every method and option.
