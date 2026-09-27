import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import pkg from './package.json'

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __CREDIT_EMAIL__: JSON.stringify('credit@example.invalid') },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  // The mock engine imports the repo's fixtures/ and contracts/ (outside app/).
  server: { fs: { allow: [resolve(__dirname, '..')] } },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 20_000,
    setupFiles: ['tests/unit/setup.ts'],
  },
})
