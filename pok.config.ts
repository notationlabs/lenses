import { defineConfig } from '@pokit/core';
import { createTerminalUI } from '@pokit/terminal';
import { release } from 'pok-plugins';

export default defineConfig({
  commandsDir: './commands',
  ...createTerminalUI(),
  appName: 'lenses',
  plugins: [
    release({
      packages: {
        files: [
          'packages/lens/package.json',
          'packages/client/package.json',
          'packages/cli/package.json',
          'packages/mcp/package.json',
        ],
        names: [
          '@djgrant/lens',
          '@djgrant/lens-client',
          '@djgrant/lens-cli',
          '@djgrant/lens-mcp',
        ],
      },
      verdaccio: true,
      build: 'pnpm -r build',
    }),
  ],
});
