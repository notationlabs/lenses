---
title: Share the persistent broker
---

# Share the persistent broker

## Context

Every client shares one detached broker process per port (default 4319) that hosts the engine, caching, and browser backends. Evidence: `packages/client/src/bridge.ts`, `packages/client/src/broker-stamp.ts`, `packages/client/src/broker-respawn.ts`, `packages/client/src/broker-lifecycle.ts`, `packages/client/src/broker-daemon.ts`, `packages/client/test/broker-lifecycle.test.ts`, `packages/client/test/broker-respawn.test.ts`, `packages/client/test/bridge-stamp.test.ts`.

## Rules

- **Connect or spawn:** !bindBroker connects to an existing broker on the port, or spawns one as a detached process and retries the connection.
- **Build stamp:** The daemon stamps itself at startup with a content hash of its own module directory and reports the stamp in its status frame.
- **Stale broker replaced:** A client whose own stamp differs asks the mismatched broker to shut down and reconnects to a freshly spawned one, so no client keeps talking to yesterday's code.
- **Bounded rebind:** Binding attempts are capped at 3; a stamp that never converges fails the bind with a stale-build error instead of looping.
- **Respawn coordination:** Concurrent clients coordinate through an atomic `mkdir` lock in the temp directory — exactly one runs the respawn while the rest wait (up to 10 s) and reconnect; a lock older than 60 s is cleared as stale.
- **Shutdown sequence:** A retiring broker stops listening first (freeing the port for its replacement), drains in-flight calls up to a 10 s bound, closes client sockets so an in-flight call still receives its result frame, releases the CDP lease under a 5 s bound, and exits; the sequence runs at most once.
- **No-browser exit:** With no connected client, no attached extension, and nothing in flight, a broker that can reach no browser exits after `LENS_BROKER_NO_BROWSER_EXIT_MS` (default 10 s).
- **Idle exit:** Under the same quiet conditions with a browser present but unused, it exits after `LENS_BROKER_IDLE_EXIT_MS` (default 15 minutes; 0 disables both windows), the longer window because a working CDP lease is expensive to reacquire after Chrome restarts.
- **Idle re-check:** The exit timer re-checks idleness when it fires — work arriving between the last reset and the deadline cancels the exit.
- **Idle lease release:** Automatic release of the CDP lease while idle is opt-in via `LENS_BROKER_IDLE_RELEASE_MS` (default off).
- **Lease control:** The control actions are `release` (drop the CDP connection so other tools can use Chrome's single consented debugging slot), `acquire` (reconnect), `status` (report without side effects), and `shutdown` (retire the broker).
- **Capability-aware selection:** Before execution, the broker derives required capabilities from the lens. A connected extension that cannot carry a credentialed HTTP body is skipped in favour of capable CDP; if no capable backend can be acquired, the call fails before making the request with extension version, negotiated capabilities, and upgrade guidance.
- **Status negotiation:** Status reports the selected backend and capabilities plus every backend's availability, version, protocol major, negotiated capabilities, and compatibility diagnostic. CLI/extension protocol or capability skew is identified as such and advises updating both components together.

## Failures

- **Whole-call deadline:** A call carries its absolute client-side deadline, so queue time counts and a stuck backend operation cannot permanently block the broker's serial request queue.
- **Timeout diagnostics:** Timeout errors identify the canonical lens, broker call ID, recording call ID when present, and the last broker progress message observed by the client.
- **Broker disconnect:** When the broker socket closes, every pending call resolves as an error result `lens broker disconnected`.
- **Extension receiver loss:** Chrome transport strings such as `Receiving end does not exist` are never returned directly. Calls receive a Lens error naming the extension backend, failed operation, lost capability, and reload/CDP recovery choices; an in-progress session is not silently replayed on another backend.

## Invariants

- **Loopback only:** The broker listens on 127.0.0.1 only, and the bridge refuses any other host.
