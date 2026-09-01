---
title: Load lens catalogs
---

# Load lens catalogs

## Context

The @caller configures ordered catalog sources; the store resolves names, files, and URLs to validated documents. Evidence: `packages/client/src/catalog.ts`, `packages/client/src/lens-store.ts`, `packages/client/test/client.test.ts`, `packages/client/test/lens-store.test.ts`.

## Rules

- **Source schemes:** A source reference dispatches by scheme — a bare or `file:` path is a live-read local directory, `git:host/owner/repo[#ref][/subdir]` is a shallow clone (`git:/abs/path` clones a local repository over a `file://` URL).
- **Directory read:** A directory source reads every `*.json` (sorted, `catalog.json` excluded) as a validated lens document; a file that fails validation fails the load naming the file.
- **Cache root:** Git clones live under `LENS_CACHE_DIR`, defaulting to `~/.cache/lenses`, keyed by a hash of the normalised reference.
- **Git materialisation:** A git source clones once with `--depth 1` (and `--branch <ref>` when a ref is given); !update re-fetches the ref with depth 1 and hard-resets to `FETCH_HEAD`.
- **Catalogue settings:** A `catalog.json` beside the documents may supply `helpers` and `params` to every document, with a document's own entry of the same name winning. Shared parameters let tenant catalogs declare one required input used by every URL.
- **Ordered load:** Sources load in configuration order; a shortname declared by several sources resolves to the earliest one.
- **Reference resolution:** A lens reference resolves as an `http(s)` URL fetched and validated directly, a path ending `.json` read from disk with the settings of its own directory's `catalog.json`, or otherwise a scoped name or shortname looked up across the loaded sources.

## Failures

- **Duplicate scoped name:** The same scoped name appearing twice — within one source or across sources — fails the load naming both sources.
- **Empty git catalog:** A git source whose directory yields no lens documents fails the load.
- **Unknown lens:** A name that no source declares fails with `unknown lens "<ref>"`.
