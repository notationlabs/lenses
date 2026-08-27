# Playwright CDP relay (copied)

These files are adapted from Microsoft Playwright (Apache-2.0):

- Upstream: https://github.com/microsoft/playwright
- Revision: `deda92d15e7d771aacaae47eb2b6e47a562c30ff` (`main`, 2026-08-27)
- Original paths:
  - `packages/playwright-core/src/tools/mcp/protocol.ts`
  - `packages/playwright-core/src/tools/mcp/browserModel.ts`
  - `packages/playwright-core/src/tools/mcp/cdpRelayV2.ts`
  - `packages/playwright-core/src/tools/mcp/cdpRelay.ts`
  - `packages/playwright-core/src/tools/utils/extension.ts` (extension ID / install URL only)

Do not import Playwright packages at runtime. Local adaptations replace
Playwright internals (`WSServer`, `ManualPromise`, `debug`, browser registry)
with `node:http` + `ws` and a small deferred helper.

The Chrome extension itself is not copied; install Microsoft's Playwright
Extension from the Chrome Web Store (`mmlmfjhmonkocbjadbfplnigmagldckm`).
