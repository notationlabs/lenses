import { defineConfig } from '@pokit/core';
import { createTerminalUI } from '@pokit/terminal';
import { release } from 'pok-plugins';

export default defineConfig({
  commandsDir: './commands',
  ...createTerminalUI(),
  appName: 'lenses',
  plugins: [
    release({
      // Listed in dependency order: client builds against lens's dist, cli
      // against both. Builds run in list order.
      packages: [
        { file: 'packages/lens/package.json', build: 'pnpm --filter @djgrant/lens run build' },
        { file: 'packages/client/package.json', build: 'pnpm --filter @djgrant/lens-client run build' },
        { file: 'packages/cli/package.json', build: 'pnpm --filter @djgrant/lens-cli run build' },
        { file: 'packages/mcp/package.json', build: 'pnpm --filter @djgrant/lens-mcp run build' },
      ],
      verdaccio: true,
    }),
  ],
});
