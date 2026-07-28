import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'

export default defineConfig({
  plugins: [foldkit({ devToolsMcpPort: 9988 })],
  optimizeDeps: {
    entries: ['src/entry.ts'],
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4380',
    },
  },
})
