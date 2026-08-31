---
title: "Proposal: perform — lens actions"
status: converged, building
---

# Perform: lens actions

A lens gains a top-level `perform` block — an ordered list of steps executed once against the bound page, after bind and before the resolve walk. Steps are writes: send a message, discard a chat. The resolve tiers then read the result back through the machinery that already exists. Test case: logged-out chatgpt.com (`@djgrant/chatgpt/send`, `@djgrant/chatgpt/clear`).

This design was converged through an exchange between two agents (Fable in `w3:p1`, droid in `w3:p8`) on 2026-08-01.

## Why not a resolver tier

Tier semantics are read semantics: miss → fall through, fields accumulate, results cache. Writes are commit-once — falling through from a failed click into a second click attempt is a double-send, not a recovery. `kind: "act"` inside `resolve` is rejected as an anti-pattern; it would be cargo-culted next to `dom` and end up in a fall-through list.

## Contract

- `perform` forces a browser bind; the http-only short-circuit does not apply to these documents.
- Bind navigation policy: `perform` present → `reuse` (freshness is only ever an explicit `navigate` step, so a send never reloads the anonymous chat out from under itself); else any intercept tier → `fresh` (legacy, e.g. `claude/usage`); else `reuse`.
- One session spans `perform` and `resolve`; readback is not a second call.
- Steps are all-or-nothing for control flow: a step failure aborts the call before any tier runs. There is no partial resolve after a half-send.
- A pure side-effect lens still declares `returns` and a read tier that confirms the effect; the engine returns data or an outcome, never void-because-it-clicked.

## Steps

`fill.value` and each value in `submit.form` are JSONata expressions over declared params — `"$message"`, not a `{hole}` template — matching the rest of the engine; an empty string is accepted directly as the empty literal. Selector fields on `fill`, `click`, `submit`, and every `wait` form expand declared `{param}` holes. Validation is a strict discriminated union over the step opcodes; unknown keys and undeclared selector holes fail closed.

| Step | Semantics |
|---|---|
| `{ "fill": sel, "value": expr }` | Focus → select-all → `insertText` (never `value=`; ProseMirror-style editors ignore property writes). The selector must resolve to exactly one element or the step hard-errors. |
| `{ "click": sel }` | Click the first visible match; error on zero matches or a disabled/`aria-disabled` target. |
| `{ "submit": sel, "form"?: { field: expr } }` | Match exactly one `<form>`, evaluate optional field expressions, populate its named native controls (adding hidden controls for absent names), then call native `requestSubmit()`, preserving constraint validation and cancellable submit-event semantics. |
| `{ "press": key }` | Named keys (`Enter`, `Meta+Enter`), never key codes. |
| `{ "wait": { "appears": sel } }` | ≥1 match present. Plain presence, no baseline memory. |
| `{ "wait": { "gone": sel } }` | 0 matches. Stateless: immediately true when already satisfied. |
| `{ "wait": { "increases": sel } }` | Match count exceeds the baseline sampled at step entry (`count > baseline`). Place it immediately after the step that triggers the change — a wait that outlives the change it watches never fires. |
| `{ "navigate": "fresh" }` | Reload of the bound target (the same reload a fresh bind performs). If the tab has drifted off-origin, navigate back to the expanded lens `url` and settle. Only `"fresh"` in v1 — free-URL navigation is a drive-by primitive. |

Every `wait` form takes `timeoutMs` (default 10000). The poll interval is internal (~150ms), not author-facing. Cut from v1: `count`/`gte` predicates, compound AND-waits, bare sleeps, `hover`, `select`, `drag`, `upload`, `evaluate`, `screenshot`.

## Consent

- Document gate (static, `validate`): `perform` non-empty ⇒ `effects.writes` non-empty; `effects.cache` absent or 0; `idempotent: true` rejected unless the steps are navigate-only (clear is idempotent; send is not).
- Call gate (dynamic): default deny. `call({ allowWrites: true })`, CLI `lens call --allow-writes`, MCP `lens_call` gains an `allowWrites` boolean (write lenses also carry `destructiveHint: true`, but the hint is not consent). Denied → error with `code: "writes_not_allowed"`.
- No inheritance: `$lens` param defaults and nested calls never inherit `allowWrites`. A read lens must not trigger a send because a default chain opted in upstream; write calls are always leaf-explicit.
- Declaration alone is not permission: non-empty `effects.writes` without `perform` stays documentary. Permission is `perform` + flag.
- Host ceiling (deferred): the orchestrator consults a policy hook that in v1 only reads the per-call flag. A broker exposed beyond the user boundary makes a config allow/deny list blocking before that ship.
- Enforcement, not convention: the orchestrator bypasses the result cache for any document with `perform`, and never auto-retries one.

## Failure and detection

- Pre-perform detect: document-level `detect` runs once against `{url, title}` after bind, before step 0. A hit returns that outcome (with the existing `needs_*` keep-tab disposition); no steps run.
- A step failure errors the call with `code: "perform_failed"` and `step` (0-based). The page is left as-is. No resolve, no cache, no retry.
- A `wait` timeout first re-runs document `detect` against `{url, title}`; a hit (e.g. `needs_auth`, `rate_limited` — authored, no magic Cloudflare detector in the engine) returns that outcome instead of `perform_failed`.
- Writes are not transactional and the result says so: any result — value, outcome, or error — from a call whose `perform` ran every step carries `performed: true`. Absence means the write did not commit. `writes_not_allowed` never carries it; `perform_failed` never carries it. A resolve miss after a successful perform is still a failed call, but the write happened — `performed: true` is how the caller finds that out.

## Naming

`perform` is the one verb end-to-end: document key, `EngineIO.perform(steps)`, `BrowserSession.perform`. `effects` stays the declaration surface ({reads, writes, idempotent, cache}) and is never overloaded with opcodes — "what it does" stays split from "how it does it". Steps are a closed, validated opcode set; the same trust story as JSONata-only maps.

## Touchpoints

| Where | Change |
|---|---|
| `packages/core/src/types.ts` | `PerformStep` union, `spec.perform`, result fields `code`/`performed`/`step` |
| `packages/core/src/validate.ts` | step union (fail closed), consent rules above |
| `packages/core/src/engine.ts` | run perform via `EngineIO.perform` before the tier walk; pre-perform detect; thread `performed` |
| `packages/core/src/page-functions.ts` | in-page step primitives shared by both backends (insertText fill, guarded click, wait probes) |
| `packages/client/src/browser-backend.ts` | `BrowserSession.perform(steps)` |
| `packages/client/src/cdp-host.ts` | CDP page/session implementation shared by Playwright Extension relay and direct CDP |
| `packages/client/src/broker-orchestrator.ts` | consent gate (policy hook), cache bypass, bind navigation policy, `specNeedsBrowser` includes `perform` |
| bridge protocol | `allowWrites` beside spec/params, default false at every layer |
| `packages/cli` | `lens call --allow-writes` |
| `packages/mcp` | `allowWrites` arg, `destructiveHint` on write lenses |
| `examples/` | migrate `chatgpt.clear` to `navigate: "fresh"` (deleting the intercept-as-write hack), add `chatgpt.send` |
| `skill/SKILL.md`, README, lens descriptions | delete "lenses cannot act"; describe perform and consent |

## Test case

`@djgrant/chatgpt/send` — params `{message}`, readback is the same dom tier as `chatgpt/chat`. Send is a separate document from `chat`: consent is a property of the document, not of whether a param was passed — an optional `message` on `chat` would make `allowWrites` depend on call shape and wreck static validation, catalog badges, and per-tool MCP hints.

```jsonc
"perform": [
  { "wait": { "appears": "#prompt-textarea" } },
  { "fill": "#prompt-textarea", "value": "$message" },
  { "wait": { "appears": "[data-testid='send-button']" } },
  { "click": "[data-testid='send-button']" },
  { "wait": { "increases": "section[data-turn='assistant']", "timeoutMs": 30000 } },
  { "wait": { "gone": "[data-testid='stop-button']", "timeoutMs": 120000 } }
]
```

Grounded on the live logged-out page: the composer is `#prompt-textarea` (contenteditable ProseMirror); the submit button is `#composer-submit-button` with `data-testid="send-button"` and `data-testid="stop-button"` / "Stop answering" while streaming; turns are `section[data-turn="user"|"assistant"]`. The send button only mounts once the composer has text — an empty composer shows dictation/voice controls in its place — so the send-button wait must come after the fill, not before (a live run caught the deadlocked original order). The rest is race-free: `increases` baselines before the network round trip completes, and `gone` is already-true-safe for responses that finish before it polls.

`@djgrant/chatgpt/clear` becomes `"perform": [{ "navigate": "fresh" }]` with the existing dom empty-thread confirm, and its intercept tier is deleted. Cut order (each shippable): A — types/validate, perform with navigate only, consent plumbing, `performed`/`code`, clear migration, tests; B — fill/click/press/wait, both backends, `chatgpt/send`, tests.
