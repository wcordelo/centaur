import { defineConfig } from 'vitest/config'
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'test/verify.test.ts',
            'test/contracts/**/*.test.ts',
            'test/adapters/**/*.test.ts',
            'test/chaos/**/*.test.ts',
          ],
        },
      },
      defineWorkersConfig({
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          poolOptions: {
            workers: {
              isolatedStorage: false,
              singleWorker: true,
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: {
                bindings: {
                  LLM_MODE: 'mock',
                  SLACK_SIGNING_SECRET: 'test-signing-secret',
                },
              },
            },
          },
        },
      }),
    ],
  },
})
