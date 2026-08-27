# Chrome Web Store permission justifications

Copy these into the dashboard only after comparing them with the built `dist/manifest.json`.

| Permission | Justification |
| --- | --- |
| `tabs` | Find, open, reuse, navigate, focus, and close only the tabs participating in user-requested lens calls; report page URL/title and detect page loading. |
| `alarms` | Wake the Manifest V3 service worker periodically so an enabled extension can reconnect to the local broker after Chrome suspends it. |
| `storage` | Store the user's enable/disable consent, known loopback broker ports, and temporary leases for tabs opened by lens calls. No captured page body is persisted here. |
| `notifications` | Tell the user when a requested call is waiting for sign-in while Chrome is not focused; clicking focuses the relevant tab. |
| `debugger` | Capture an opt-in full-page recording of the participating background tab. Chrome's visible-tab capture could capture the wrong active tab; the debugger is attached only for the capture and immediately detached. |
| `scripting` | Run a same-origin fetch in an already-open matching page for a user-requested lens source. The injected function verifies the origin again immediately before sending. |
| `<all_urls>` host access | Users can provide lens documents for arbitrary sites. Access lets the extension execute requested credentialed fetches, observe eligible JSON responses, extract declared page content, and perform declared actions on the selected site. Restricting this to a fixed domain list would defeat the user-configurable single purpose. |

## Content script and scoped page interception

One packaged isolated-world content script runs at `document_start` to provide local extraction/action primitives and a dormant relay. JSON fetch/XHR interception is injected into the page's main world only while an active browser session owns that tab, uses an unguessable per-session token, and is removed when the session releases the tab. Eligible bodies are bounded and held in extension memory. Data is returned to the loopback broker only in response to a lens RPC after the user has enabled the bridge. No remotely hosted code is loaded or evaluated.

## Reviewer notes

1. Install and pin the action.
2. Click the action, review the disclosure, check the acknowledgement, and choose **Enable Lenses**.
3. Run the documented local client/broker. The action changes from **Waiting** to **Connected** and displays a `127.0.0.1` port.
4. Run a read-only example lens to demonstrate tab reuse/extraction.
5. Optional debugger verification: start an explicit recording from the local client, observe Chrome's debugging indicator, then verify it clears when capture completes.
6. Choose **Disable local bridge** to close active loopback connections.

Provide the reviewer with exact install and example commands for the release commit; do not require unpublished credentials.
