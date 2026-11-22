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

const finishChunk: StreamChunk = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: undefined },
  usage: { inputTokens: NO_INPUT_TOKENS, outputTokens: NO_OUTPUT_TOKENS },
}

/** 呼ばれるたびに replies を先頭から 1 つずつ、1 チャンクで返すモデル。最後の 1 つは繰り返す。 */
export const textModel = (...replies: string[]): MockLanguageModelV3 => {
  let call = 0
  return new MockLanguageModelV3({
    // onChatMessage は streamText を使うので doStream だけ実装すれば足りる。
    doStream: async () => {
      const text = replies[Math.min(call++, replies.length - 1)] ?? ''
      const chunks: StreamChunk[] = [
        { type: 'text-start', id: '1' },
        ...(text.length > 0 ? [{ type: 'text-delta' as const, id: '1', delta: text }] : []),
        { type: 'text-end', id: '1' },
        finishChunk,
      ]
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
}

/** textModel と同じく replies を返すが、毎回その前に thinking（reasoning）を出す。 */
export const reasoningModel = (reasoning: string, ...replies: string[]): MockLanguageModelV3 => {
  let call = 0
  return new MockLanguageModelV3({
    // Claude は thinking を止められないので、実際にも毎ターンの応答に reasoning が含まれる。
    doStream: async () => {
      const text = replies[Math.min(call++, replies.length - 1)] ?? ''
      const chunks: StreamChunk[] = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: reasoning },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: text },
        { type: 'text-end', id: '1' },
        finishChunk,
      ]
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
}

/** 生成を呼ぶと必ず失敗するモデル。モデルの構築は成功する。 */
export const failingModel = (): MockLanguageModelV3 =>
  new MockLanguageModelV3({
    doStream: async () => {
      throw new Error('boom')
    },
  })

/** 会話キーに対応する Agent の DO を掴む。 */
// getAgentByName の ID 導出は素の idFromName なので、本番コードと同じ DO になる。
export const stub = (key: string): DurableObjectStub<LineChatAgent> =>
  env.LineChatAgent.get(env.LineChatAgent.idFromName(key))

/** 会話キーに対応する DO の createModel() が model を返すようにする。 */
export async function stubModel(
  key: string,
  model: MockLanguageModelV3,
): Promise<DurableObjectStub<LineChatAgent>> {
  const target = stub(key)
  // env.AI はバインディング RPC なのでグローバル fetch のスタブでは捕まえられず、
  // インスタンスのメソッドを直接差し替えるのが唯一の継ぎ目になる。
  await runInDurableObject(target, (instance) => {
    vi.spyOn(instance as unknown as { createModel: () => unknown }, 'createModel').mockReturnValue(
      model,
    )
  })
  return target
}

/** テスト間の後始末。すべての Agent の DO のアラームとストレージを消す。 */
export async function cleanupAgents(): Promise<void> {
  // 1 ターン走ると AIChatAgent がストリームバッファ掃除用のアラームを仕掛ける。
  // これが残っているとテストが終わっても vitest のプロセスが終了しない。
  for (const id of await listDurableObjectIds(env.LineChatAgent)) {
    await runInDurableObject(env.LineChatAgent.get(id), (_instance, state) =>
      state.storage.deleteAlarm(),
    )
  }
  // 0.18 には isolatedStorage が無く、消さないと履歴が次のテストに持ち越される。
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
