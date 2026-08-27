# Chrome extension release and submission

## Build a reviewable upload

From the repository root:

```sh
pnpm --filter @djgrant/lenses-extension-chrome check:metadata
pnpm --filter @djgrant/lenses-extension-chrome release:zip
```

The second command type-checks, deletes the previous `dist`, builds only the allowlisted packaged files, creates `artifacts/lenses-chrome-<version>.zip`, validates its central directory, and prints its SHA-256. ZIP entries are sorted, stored with fixed timestamps/modes, and contain no source maps or hidden files, so identical inputs produce identical bytes.

Run the command twice from a clean checkout and compare SHA-256 values before upload. Also load `extensions/chrome/dist` unpacked and exercise onboarding, enable/disable, status, one read, one explicitly approved write, sign-in notification, and an opt-in recording.

## Version source and assertion

`extensions/chrome/package.json` is the release version source. The checked-in `manifest.json` remains directly loadable for development, so metadata validation requires its mirrored version to match. Update both in one release change; `build.mjs` writes the package version into the packaged manifest after the assertion. Chrome versions must contain one to four numeric components.

## Manifest key and extension identity

`manifest.key` is a **public** DER key encoded as base64. It is checked in to keep unpacked/test installations on the intended identity; it is not a signing private key. Metadata validation parses it as an RSA public key and asserts that it derives extension ID:

```text
mbanohpojdbbnbnmppepaihihmkoibaj
```

Before the first Web Store upload, compare that ID/key with the item's **Package → Public key** value in the Chrome Web Store dashboard. If the existing dashboard item has another identity, do not casually replace either key: establish which item is canonical, update `EXPECTED_EXTENSION_ID` deliberately, and document migration impact. Never put a `.pem`, private key, dashboard credential, or upload token in this repository or ZIP. The Web Store performs release signing.

For CI tied to a different intentional store identity, `LENSES_EXTENSION_EXPECTED_ID` can override the expected ID, but public releases should keep the checked-in assertion current.

## Submission checklist

- [ ] Version and key validation passes.
- [ ] Tests and extension build pass from a clean checkout.
- [ ] Repeated release builds have the same SHA-256.
- [ ] `unzip -l` shows only the allowlisted extension files and `manifest.json` is at ZIP root.
- [ ] Store listing and permission text match the actual release.
- [ ] Privacy policy is published at the dashboard URL and matches `PRIVACY_POLICY.md`.
- [ ] Required screenshots/promotional images satisfy current Web Store dimensions and show this release's real UI.
- [ ] Dashboard data-use disclosures are reviewed, not blindly copied.
- [ ] A monitored support email and reviewer instructions are present.
- [ ] Upload ZIP and retain the commit, ZIP SHA-256, submission date, and dashboard release number.
