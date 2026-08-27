# Store asset inventory

## Included and release-ready

- Extension icon source: `../icons/icon128.png` (128×128 PNG, also packaged at 16, 32, 48, and 128 px).
- Listing copy: `LISTING.md`.
- Permission/reviewer explanations: `PERMISSIONS.md`.
- Privacy policy source: `PRIVACY_POLICY.md`.
- In-extension privacy copy: `../privacy.html`.

Do not upload the old root-level `../icon128.png`; the canonical packaged set is `../icons/`.

## Capture manually from the release candidate

Chrome Web Store listing imagery should depict the actual extension, not a fabricated mock. Capture after loading the built release and connecting the documented broker:

1. **Onboarding:** action open at first run, showing the disclosure and disabled Enable button.
2. **Ready:** enabled action showing a live `127.0.0.1` connection and release version.
3. **In use:** a non-sensitive demonstration page alongside the extension/action outcome. Remove account names, tokens, bookmarks, and unrelated browser chrome.

At submission time, verify current Chrome Web Store dimensions and counts. Historically accepted screenshot sizes may change; use the dimensions shown by the dashboard rather than resampling stale screenshots. Keep lossless source captures outside the ZIP, and place approved dashboard assets in `store/assets/` with descriptive names only after privacy review.

## Still requires design/dashboard work

- A reviewed small promotional tile and marquee image, if the dashboard or desired merchandising requires them.
- Final screenshots from the signed release candidate.
- A stable hosted HTTPS privacy-policy URL.
- Final developer display name, monitored support email, category, regions, and distribution visibility.
