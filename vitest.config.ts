import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { TEST_CHANNEL_ACCESS_TOKEN, TEST_CHANNEL_SECRET } from './test/fixtures/line'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // 実際のシークレットは使わず、テスト専用のダミー値を注入する。
      miniflare: {
        bindings: {
          LINE_CHANNEL_SECRET: TEST_CHANNEL_SECRET,
          LINE_CHANNEL_ACCESS_TOKEN: TEST_CHANNEL_ACCESS_TOKEN,
        },
      },
    }),
  ],
})
