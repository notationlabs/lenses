# Lenses: Design

Technical companion to [lens-pitch.md](./lens-pitch.md). Written for a developer; assumes the pitch was read.

## The signature every browser tool reduces to

A scraper, an MCP tool, a vision agent, and a hand-written API wrapper differ in implementation but converge on the same shape:

```
f(url) → value
```

The interesting design question isn't how to implement `f` better. It's what constraints on the *signature* would make the universe of such functions composable across teams.

## The function is a URL

Replace `f` with a URL pointing to a document that describes it. The library turns that URL into a callable:

```ts
const replies = lens("https://bridges.dev/twitter/replies@v1");
const value   = await replies("https://x.com/user/status/123");
```

The lens URL is a document — fetchable, versionable, forkable — describing how to perform an operation on pages matching a pattern. The target URL is the page to act on. Both sides live in the same global address space (HTTP), so the address space for functions is the address space we already have: no registry needs to be built, the pair is itself a hyperlink that can be pasted into a chat or stored as a string, and the author of a lens for site X is free to be someone other than the operator of site X.

## Results are lenses too

A lens declares its return schema. Fields in that schema are either primitives (`string`, `datetime`) or *lenses* — typed, callable references to other lenses, already bound to the right target:

```ts
returns: {
  text:   string,
  author: lens("https://bridges.dev/twitter/profile@v1"),
  parent: lens("https://bridges.dev/twitter/replies@v1"),
}
```

When the host materialises a reply, `reply.author` is itself a callable lens. Calling `await reply.author()` fetches the profile, whose own fields may be further lenses to call. Traversal across the web reduces to repeated application of one operation: call a lens, receive a value, find lenses inside it, call those. Pagination is a lens that takes a cursor; following a link is calling the lens its field points to; liking a tweet is calling a write lens. One primitive, applied recursively.

## Types flow through the lens URL

The lens URL passed to `lens(...)` is a string literal, known at the time the calling code is written. Its static type is therefore the return type of the lens at that URL — `Lens<"twitter/profile@v1">` resolves directly to the profile schema, with no dereferencing required.

Multi-hop walks become statically checkable:

```ts
const replies   = await lens("twitter/replies@v1")(post);
const authors   = replies.map(r => r.author);              // Lens<profile@v1>[]
const followers = await Promise.all(
  authors.map(a => a().then(p => p.followers()))            // type-checked
);
```

A planner can read a proposed walk, compute its expected cost (each lens declares its cost tier in `effects`), identify which steps touch write lenses requiring confirmation, and decide whether to proceed — entirely without hitting the network.

## Outcomes are lenses to their own fix

Web operations fail in structured ways: logged out, rate limited, two-factor prompt, page moved, payment required. A lens declares these as named outcomes alongside its return schema, and each outcome's value is itself a lens pointing at the operation that resolves the condition:

```ts
outcomes: {
  needs_auth:   lens("https://bridges.dev/twitter/login@v1"),
  rate_limited: { retry_after: duration },
  not_found:    null,
}
```

When the lens detects a logged-out state during execution (HTTP 401 from the intercepted API, a redirect to `/i/flow/login`, an LLM judgement on a login wall), it returns `{ needs_auth: lens("...login@v1")("https://x.com/") }`. The host surfaces this to the conversation; the user logs in; the agent retries the original call. Because the login result is structurally the same as any other lens result, the retry loop is the same code path that handled the original request — the runtime treats "got the data" and "got back something to call next" as the same shape.

## Three resolvers, cheapest first

A lens declares up to three strategies for satisfying a call. The host runs them in order and falls through on miss.

1. **Intercept.** The lens describes a request the page already makes and a path through its response. When the user visits the page, that request fires; the host reads the response and projects it through the lens's `map` function. Zero extra network cost.

2. **DOM.** When interception misses (different page state, API changed), fall through to selectors against the rendered DOM. Deterministic, still no LLM cost.

3. **LLM.** When the DOM matches neither (redesign, A/B variant), pass the page snapshot to a language model with the declared return schema. Expensive, always available.

The author writes the layers in priority order; the host falls through automatically. A lens that has dropped to its LLM layer is still serving requests — it is simply serving them on the expensive layer, and a maintainer (human or agent) can watch which lenses are running there and patch the cheaper layers back. The LLM's transcripts are the data needed to do that patching.

## The host runs in your own browser

The runtime that fetches lens definitions and executes them is a browser extension installed in the user's everyday browser. Session cookies are the user's own, so auth is whatever the user already has. A CAPTCHA prompt becomes a `needs_captcha` outcome that the user solves in the tab they were going to look at anyway. The posture is the same as Greasemonkey or uBlock: the user is the one taking the action, and the lens is structuring its output.

This rules out background, headless, at-scale operation, and that tradeoff is deliberate. The operations this design optimises for ("any new replies from people I follow?", "what's my credit balance?", "draft a response to this email") happen when a user is at the keyboard. Scale headless scraping is a different product on top of the same convention.

## A lens, complete

```ts
import {
  defineLens, lens, url, intercept, dom, llm,
  stream, string, datetime, duration, seconds,
} from "@actors/lens";

export default defineLens({
  lens:    "twitter/replies",
  version: 1,

  accepts: url`https://x.com/${"handle"}/status/${"id"}`,

  returns: stream({
    text:   string,
    posted: datetime,
    author: lens("https://bridges.dev/twitter/profile@v1"),
    parent: lens("https://bridges.dev/twitter/replies@v1"),
    like:   lens("https://bridges.dev/twitter/like@v1"),
  }),

  outcomes: {
    needs_auth:   lens("https://bridges.dev/twitter/login@v1"),
    rate_limited: { retry_after: duration },
    not_found:    null,
  },

  effects: {
    reads:      ["x.com/timeline", "x.com/tweet"],
    writes:     [],
    idempotent: true,
    cache:      seconds(30),
    cost:       { intercept: "free", dom: "cheap", llm: "paid" },
  },

  resolve: [
    intercept({
      capture: {
        request:  "GET https://x.com/i/api/graphql/*/TweetDetail*",
        response: r => r.data.threaded_conversation_v2
                        .instructions.flatMap(i => i.entries),
      },
      detect: {
        needs_auth:   r => r.status === 401,
        rate_limited: r => r.status === 429,
      },
      map: r => ({
        text:   r.legacy.full_text,
        posted: new Date(r.legacy.created_at),
        author: lens("twitter/profile@v1")(`https://x.com/${r.screen_name}`),
      }),
    }),

    dom({
      when:     ctx => ctx.intercept.missed,
      selector: "article[data-testid='tweet']",
      detect:   { needs_auth: ctx => ctx.url.includes("/i/flow/login") },
    }),

    llm({
      when:   ctx => ctx.dom.empty,
      prompt: "Extract replies as the item schema.",
    }),
  ],
});
```

A write lens shares the same shape, with a non-empty `writes` and an action body in each resolver:

```ts
export default defineLens({
  lens:    "twitter/like",
  accepts: url`https://x.com/${"handle"}/status/${"id"}`,
  returns: lens("https://bridges.dev/twitter/replies@v1"),

  outcomes: { needs_auth: lens("https://bridges.dev/twitter/login@v1") },

  effects: {
    reads: [], writes: ["x.com/like"],
    idempotent: true,
    cost: { intercept: "free", dom: "cheap", llm: "paid" },
  },

  resolve: [
    intercept({
      fire: "POST https://x.com/i/api/graphql/*/FavoriteTweet",
      body: ({ id }) => ({ tweet_id: id }),
    }),
    dom({
      action: ctx => ctx.click("[data-testid='like']"),
    }),
  ],
});
```

Read and write share the calling convention, which is what makes effects auditable: the host decides before any call whether to permit it, based purely on `effects`, without parsing per-site code.

## The runtime, end to end

One pass through the host when an agent calls a lens:

1. Fetch the lens definition from `lens_url` (cached). Validate `target_url` against `accepts`.
2. Check the lens's `effects` against the conversation's policy. Auto-allow reads under known prefixes; require confirmation for writes; refuse anything denied.
3. Find an open tab matching `target_url`, or open one in the background.
4. Run the `resolve` list in order. For `intercept`, register a `webRequest` listener; for `dom`, inject selectors; for `llm`, snapshot the page and call out.
5. After each layer: check `detect` rules. If an outcome triggers, return it. If the layer produced a value, return it. Otherwise advance.
6. Cache the result under `(lens_url, target_url, args_hash)` with the lens's declared TTL.
7. Return the value into the conversation. The chat surface renders embedded lenses as chips the user can click.

Per-site behaviour lives entirely in the lens. The host carries no per-service code, no per-service authentication module, and no plugin system.

## Smallest test

To validate the calling convention, the minimum is:

1. The browser extension host implementing the seven runtime steps above with all three resolvers.
2. The `@actors/lens` library: `defineLens`, the typed builders (`intercept`, `dom`, `llm`, `stream`, `lens`, etc.), and a build step that extracts a canonical JSON spec.
3. Three hand-written lenses: `twitter/replies`, `twitter/profile`, `twitter/login`.
4. A chat surface where the user types "any new replies from people I follow?" and an agent composes those three lenses into an answer.

If the experience is preferable to opening the tab manually, the calling convention is doing its job. Everything after that is breadth: more lenses, more sites, an LLM authoring loop that drafts a lens from a recorded user action.

## Out of scope

- **Headless / background execution.** A separate product on top of the same convention.
- **Cross-user lens execution.** A lens runs in one user's session; sharing happens at the data level.
- **Automated lens repair.** Real and important, but the repair agent is a host-level concern subscribing to failure messages, not a feature of the lens.
- **A canonical registry.** GitHub is the registry. Discovery is a UX layer on top of GitHub search.
