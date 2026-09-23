---
title: Wait for interactive sign-in
---

# Auth wait leases

A `lens_call` that returns `needs_auth` can hold its original client request open while the user signs in. The default lease is 120 seconds for interactive CLI calls and MCP calls with a progress token. Library calls, non-interactive CLI calls, and MCP calls without a progress token default to zero; a caller can explicitly opt in. Callers can set `authLeaseMs` (CLI `--auth-lease-ms`) to override this, including zero to preserve the old behavior. The execution timeout and authentication lease are separate budgets.

- **Serial execution:** Each lens attempt runs in the broker's serial queue. Once it returns `needs_auth`, the broker parks the call outside that queue. When the gate moves, the broker queues a new attempt. It never holds the queue while awaiting a human.
- **Gate:** A page kept after `needs_auth` is brought forward. If an HTTP-only call produced the outcome, the backend opens the lens URL in a separate sign-in tab. The tab shows a black countdown banner with a white border while its page is available. A settled change in the gate's URL on its target origin can wake a retry, *not* prove authentication. The broker also checks once per second: a multi-page login can replace the original page without a usable navigation event. Retries bypass the stale gate but only read an already-open tab at the lens URL. If no controlled tab has reached that URL, the lease keeps waiting without opening or navigating a tab. Only a fresh lens execution on that tab can return success. Cross-origin OAuth hops alone do not trigger a rerun. No password or page data is returned to the broker by the prompt.
- **Success:** A fresh call attempt determines whether authentication worked. Another `needs_auth` parks it again. A normal value or error resolves the original client request. A retry cannot inherit a stale result cache: only successful values are cached.
- **Writes:** A write lens may be retried only if it has `perform` steps and none began in the previous attempt. Mutating HTTP lenses and calls that reached any perform step return their original `needs_auth` outcome instead of being automatically retried.
- **Concurrent calls:** Calls to the same origin share one gate and prompt, with independent absolute expiry times. The prompt shows the latest expiry and the number of requests still waiting. A closed or detached tab removes its prompt, but does not end the authentication lease; the broker continues checking until the deadline. If a particular lease expires, only that call returns its original `needs_auth` outcome.
- **Client lifecycle:** The original WebSocket request stays pending; the bridge's timer includes the execution timeout plus the authentication lease. Broker shutdown and lost client connections do not persist pending waits. MCP progress notifications are sent when the caller supplies a progress token.

The browser's CDP lease is unrelated to these per-call auth wait leases.
