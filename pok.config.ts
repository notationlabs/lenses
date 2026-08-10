import { defineConfig } from '@pokit/core';
import { createTerminalUI } from '@pokit/terminal';
import { release } from 'pok-plugins';

export default defineConfig({
  commandsDir: './commands',
  ...createTerminalUI(),
  appName: 'lenses',
  plugins: [
    release({
      // The source packages remain separate private workspaces. One bundled
      // package is the complete public surface and the only publishable unit.
      packages: [
        { file: 'packages/lenses/package.json', build: 'pnpm --filter @djgrant/lenses run build' },
      ],
      verdaccio: true,
    }),
  ],
});
