# Chrome Web Store listing

Use this as the reviewed source for the dashboard listing. Re-check character limits when submitting.

## Product details

**Name:** Lenses — Local Browser Bridge

**Summary:** Run user-requested Lenses calls in your signed-in Chrome session through a private local bridge.

**Category:** Developer Tools

**Language:** English

## Detailed description

Lenses turns declared webpage operations into typed functions for local developer tools, command-line clients, and MCP clients.

The extension is the browser-side bridge. When you enable it, a Lenses client running on your computer can ask Chrome to read a declared result, make a website request using your existing signed-in session, open or reuse a tab, or perform an action you explicitly requested. The extension connects only to the local Lenses broker on `127.0.0.1`; there is no developer-operated Lenses cloud service.

The toolbar action provides first-run disclosure, an enable/disable control, extension version, and live local connection status. Calls that need sign-in bring the relevant tab forward and can show a Chrome notification. Browser recording is opt-in from the calling Lenses client.

Broad website access is needed because users can install lens documents for different websites. Lenses uses that access only while servicing user-requested calls. Website content and response data are processed locally and are not sent to the extension developer.

Requires the open-source Lenses client/broker. Documentation and source: <https://github.com/notationlabs/lenses>

## Privacy dashboard answers

These answers must match the current Chrome Web Store questionnaire wording at submission time.

- **Single purpose:** Connect user-invoked local Lenses clients to the user's Chrome session to execute declared webpage reads and actions.
- **Personally identifiable information:** potentially handled (website content can contain it), not collected by the developer.
- **Authentication information:** potentially handled through the browser's existing session; passwords and cookies are not exported by the extension.
- **Website content:** handled for user-requested extraction, response capture, screenshots, and actions.
- **Web history:** current/participating tab URLs are handled to select and manage tabs; not used to build a browsing profile.
- **User activity:** user-requested browser actions and page responses are handled; no analytics or tracking.
- **Financial/health/location/communications:** may incidentally appear in a site the user chooses; not collected for a separate purpose.
- Data is **not sold**, **not used for advertising**, **not used for creditworthiness/lending**, and **not transferred except to the user's local broker or a destination website needed to perform the user's request**.
- Data use is limited to the extension's prominently disclosed single purpose.

## Required dashboard fields

- Privacy policy URL: publish `PRIVACY_POLICY.md` at a stable HTTPS URL (a repository blob URL is not ideal; use the project website).
- Homepage/support URL: `https://github.com/notationlabs/lenses`
- Support contact: set a monitored address in the developer dashboard.
- Distribution: choose intentionally; do not assume Unlisted is equivalent to testing.
