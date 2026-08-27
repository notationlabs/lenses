# Lenses Chrome Extension Privacy Policy

**Effective date:** 6 August 2026

Lenses is a local browser bridge. It does not operate an analytics, advertising, account, or remote data-collection service.

## Data the extension can process

Only when the user enables the bridge, user-requested lens calls may ask the extension to process page URLs, page titles, visible page content, JSON response bodies, screenshots, and results of browser actions. Calls can use the user's existing website session. This data may include personal or sensitive information displayed by a website.

## How data is used

Data is used only to complete the lens call requested by the user or their local software. The extension exchanges call data with the Lenses broker over loopback WebSocket connections at `127.0.0.1`. It does not send this data to the extension developer. An operation the user requests may send data to the destination website, just as the equivalent browser action would.

## Storage and retention

The extension stores the user's enable/disable choice in Chrome extension-local storage. It stores known local broker ports and temporary tab bookkeeping in Chrome session storage. Captured response data is held in memory and discarded when the extension service worker, relevant tab, or browser session ends.

Other Lenses software may save command output or browser recordings when the user explicitly requests that behavior. Such storage is outside this extension and is controlled by the user.

## Sharing, sale, and prohibited uses

The developer does not sell extension data, use it for advertising, use it for credit or lending decisions, or share it with third parties. Data is disclosed only to local software and destination websites needed to carry out the user's request, or if legally required.

## User choices

The toolbar action lets the user disable the local bridge at any time. Removing the extension revokes its Chrome permissions and removes its extension storage according to Chrome's behavior. Data held by websites remains subject to each website's controls and privacy policy.

## Security

The extension accepts broker connections only over loopback addresses and does not load remotely hosted executable code. Chrome permissions and website access are used only for user-requested lens calls and the status/onboarding experience.

## Contact

Privacy and security questions can be filed at <https://github.com/notationlabs/lenses/issues>. Because the extension has no developer-operated collection service, the developer normally has no extension data to identify or delete.
