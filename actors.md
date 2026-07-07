# A Chat App for Actors

A unified workspace where humans and programs collaborate on the web.

## The Core Insight

Anything can be an actor — a person, an LLM, a script, a webpage — so long as it receives messages, holds its own state, and sends messages.

Once everything speaks the same protocol, you can talk to an AI agent that talks to a webpage, in the same chat, with the same affordances. That composition is the product.

## Two Primitives

- **Actors** — independent entities that do work. They mix and match because they only communicate via messages.
- **Conversations** — the rooms where actors interact and pass messages. Shared context lives here, not inside actors.

## The Web Bridge

The most valuable surface that lacks a machine-readable interface is the web. A Web Bridge turns any webpage into an actor.

It runs as a **browser extension in the user's everyday browser**, which collapses the hardest problems in web automation:

- **Auth is free** — the user is already logged in.
- **CAPTCHAs become messages** — the bridge asks the user in chat, the user solves it in the tab.
- **No proxies, no session management, no legal grey area** — the user is taking the action; the bridge is structuring it.

Each bridge is configured by a small **DSL document** describing how to map a site to actor-shaped operations. It can be:

- hosted by the site itself at a well-known URL (like `robots.txt` or `openid-configuration`), or
- published by a third party as a gist or GitHub repo.

GitHub becomes the marketplace. No central registry, no vendor cooperation required.

## Why the DSL Wins on Cost

Most browser agents drive the DOM with a vision model. Slow, expensive, brittle.

The DSL describes the *real* interface a modern site already exposes:

- **Intercept the API calls the page is already making.** A few lines of schema turn an unstructured site into a typed API.
- **Fall through to DOM actions** when there's no API.
- **Yield to an LLM** as the final escape hatch.

The more precise the map, the cheaper the execution. One person authors a bridge once; everyone benefits. That's the flywheel.

## Resilience by Supervision

When a site changes and a bridge breaks, it throws an exception into the conversation. A Maintenance Actor catches it, inspects the new page, and proposes an update to the bridge document. Erlang-style supervision, applied to the open web.

## Why Now

- LLMs are good enough to author and repair bridge documents.
- MCP proved the appetite for agent-callable interfaces — but requires the *service* to ship a server. This requires only a *document*, which a third party can publish.
- Browser extensions remain the one place an agent can act with a user's full identity, safely and legally.

## The Smallest Test

Extension + a hand-written `linkedin.yaml` that intercepts the notifications API + a chat box that asks "any new messages from recruiters?" If that feels noticeably better than opening the tab, the thesis has legs.
