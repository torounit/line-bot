import { listDurableObjectIds, reset, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { vi } from 'vitest'
import type { LineChatAgent } from '../../src/agent'

// @ai-sdk/provider は直接の依存ではないので、モックの戻り値からチャンク型を取り出す。
type StreamResult = Awaited<ReturnType<MockLanguageModelV3['doStream']>>
type StreamChunk = StreamResult['stream'] extends ReadableStream<infer C> ? C : never

// トークン数はどのテストでも検証しないので 0 で埋める。
const NO_INPUT_TOKENS = { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }
const NO_OUTPUT_TOKENS = { total: 0, text: 0, reasoning: 0 }

/**
 * onChatMessage は streamText を使うので doStream だけ実装すれば足りる。
 * 渡したテキストを 1 チャンクで返す。
 */
export const textModel = (...replies: string[]): MockLanguageModelV3 => {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      const text = replies[Math.min(call++, replies.length - 1)] ?? ''
      const chunks: StreamChunk[] = [
        { type: 'text-start', id: '1' },
        ...(text.length > 0 ? [{ type: 'text-delta' as const, id: '1', delta: text }] : []),
        { type: 'text-end', id: '1' },
        {
          type: 'finish',
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: { inputTokens: NO_INPUT_TOKENS, outputTokens: NO_OUTPUT_TOKENS },
        },
      ]
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
}

/** 呼び出すと必ず失敗するモデル。モデル構築ではなく生成の失敗を再現する。 */
export const failingModel = (): MockLanguageModelV3 =>
  new MockLanguageModelV3({
    doStream: async () => {
      throw new Error('boom')
    },
  })

export const stub = (key: string): DurableObjectStub<LineChatAgent> =>
  env.LineChatAgent.get(env.LineChatAgent.idFromName(key))

/**
 * 会話キーに対応する DO の createModel() を差し替える。
 * env.AI はバインディング RPC なのでグローバル fetch のスタブでは捕まえられず、
 * インスタンスのメソッドを直接差し替えるのが唯一の継ぎ目になる。
 * getAgentByName の ID 導出は素の idFromName なので、本番コードと同じ DO を掴める。
 */
export async function stubModel(
  key: string,
  model: MockLanguageModelV3,
): Promise<DurableObjectStub<LineChatAgent>> {
  const target = stub(key)
  await runInDurableObject(target, (instance) => {
    vi.spyOn(instance as unknown as { createModel: () => unknown }, 'createModel').mockReturnValue(
      model,
    )
  })
  return target
}

/**
 * テスト間の後始末。
 * 1 ターン走ると AIChatAgent がストリームバッファ掃除用のアラームを仕掛ける。
 * これが残っているとテストが終わっても vitest のプロセスが終了しないので、明示的に消す。
 * あわせて DO のストレージを空にする（0.18 には isolatedStorage が無く履歴が持ち越されるため）。
 */
export async function cleanupAgents(): Promise<void> {
  for (const id of await listDurableObjectIds(env.LineChatAgent)) {
    await runInDurableObject(env.LineChatAgent.get(id), (_instance, state) =>
      state.storage.deleteAlarm(),
    )
  }
  await reset()
}

/** モデルに渡された prompt を検査できるよう、モック本体も一緒に返す。 */
export async function stubModelWithCalls(
  key: string,
  ...replies: string[]
): Promise<{ target: DurableObjectStub<LineChatAgent>; model: MockLanguageModelV3 }> {
  const model = textModel(...replies)
  const target = await stubModel(key, model)
  return { target, model }
}
