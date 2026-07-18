import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { TEST_CHANNEL_ACCESS_TOKEN, TEST_CHANNEL_SECRET } from './test/fixtures/line'

export default defineConfig({
  test: {
    // ai バインディングはテストでもリモート接続を張る。ファイルを並列に走らせると
    // 接続が同時に何本も立ち上がり、cloudflare-pool runner の起動がタイムアウトする。
    fileParallelism: false,
    // AIChatAgent はターンが失敗すると _tryCatchChat が `throw this.onError(e)` を
    // 浮いた Promise で再送出するため、こちらで捕捉できない未処理 rejection が残る。
    // 失敗自体は saveMessages の status 経由で ask() が例外にしており、テストで検証済み。
    dangerouslyIgnoreUnhandledErrors: true,
  },
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
