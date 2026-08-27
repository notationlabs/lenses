# Chrome Web Store releases

`.github/workflows/chrome-web-store-release.yml` tests, builds, creates a deterministic ZIP, uploads it with Chrome Web Store API v2, waits for asynchronous upload processing, and calls `publish` with `DEFAULT_PUBLISH`. This submits the extension for review and publishes it automatically after approval. Store validation warnings fail the release rather than being silently accepted.

## One-time setup

1. In a Google Cloud project, enable **Chrome Web Store API** and create a service account. It needs no Google Cloud project role for the Web Store itself.
2. In **Chrome Web Store Developer Dashboard → Account**, add that service account email to the publisher. The Web Store currently permits one service account per publisher.
3. Configure [GitHub OIDC Workload Identity Federation for Google Cloud](https://github.com/google-github-actions/auth#setup). Grant the GitHub identity `roles/iam.workloadIdentityUser` on the service account and restrict the provider to this repository. Prefer a subject restricted to the `chrome-web-store` GitHub environment (`repo:OWNER/REPO:environment:chrome-web-store`), not a repository-wide wildcard. No service-account JSON key is required.
4. Create a protected GitHub environment named `chrome-web-store`. Add required reviewers and restrict deployment to the default branch (for manual dispatches) and tags matching `chrome-v*`.
5. Define these **environment variables** on `chrome-web-store`:

   | Variable | Value |
   | --- | --- |
   | `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full provider resource name, such as `projects/123/locations/global/workloadIdentityPools/github/providers/lenses` |
   | `GCP_SERVICE_ACCOUNT` | Service account email added to the Web Store dashboard |
   | `CWS_PUBLISHER_ID` | Publisher ID from **Developer Dashboard → Publisher → Settings** |
   | `CWS_EXTENSION_ID` | Extension ID from the Web Store/dashboard |

The workflow requests only the `https://www.googleapis.com/auth/chromewebstore` OAuth scope. Keep WIF trust and all four variables on the protected environment so unreviewed jobs cannot use the publishing identity.

## Release

1. Update both `extensions/chrome/manifest.json` and `extensions/chrome/package.json` to the same Chrome-compatible version (one to four integer components).
2. Merge and ensure normal CI is green.
3. Tag that exact commit and push the tag:

   ```sh
   git tag -a chrome-v0.4.1 -m "Chrome extension 0.4.1"
   git push origin chrome-v0.4.1
   ```

The tag version must exactly equal both files. The workflow uses a frozen pnpm lockfile, tests the repository, removes old extension build output, rebuilds, and archives sorted files with fixed timestamps and permissions. The ZIP and its SHA-256 are retained as a workflow artifact.

To retry an existing tag, run **Publish Chrome extension** manually and enter `chrome-v0.4.1`. Manual runs still check that the tag exists, points to the checked-out commit, and matches both versions. Do not move a release tag; create a new version instead.

Upload processing is polled for up to ten minutes. A failed/timed-out upload, API warning, or unexpected submission state stops the workflow. After a successful run, follow review state in the Developer Dashboard; API acceptance does not mean review has completed.

API references: [use the Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api), [service accounts](https://developer.chrome.com/docs/webstore/service-accounts), and [API v2 REST reference](https://developer.chrome.com/docs/webstore/api/reference/rest).
