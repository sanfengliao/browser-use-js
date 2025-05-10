import tsConfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: -1,
  },
  plugins: [tsConfigPaths()],
})
