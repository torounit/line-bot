import { runDurableObjectAlarm } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LineChatAgent } from '../src/agent'
import {
  cleanupAgents,
  failingModel,
  stubModel,
  stubModelWithCalls,
  textModel,
} from './helpers/agent-stub'
import { type CapturedRequest, stubLineApi } from './helpers/fetch-stub'

const REPLY_URL = 'https://api.line.me/v2/bot/message/reply'

const replyTexts = (calls: CapturedRequest[]): string[] =>
  calls
    .filter((c) => c.url === REPLY_URL)
    .map((c) => (c.body as { messages: { text: string }[] }).messages[0].text)

/**
 * 1 ターンを走らせて返信本文を返す。
 * 生成と返信は alarm の中で行われるので、依頼 → 発火 → 返信の到着まで待つ。
 * schedule(0) はほぼ即時なので miniflare が自発的に発火する場合もあり、
 * 発火経路は問わず返信が増えたことだけを見る。
 */
const conversation = (agent: DurableObjectStub<LineChatAgent>, calls: CapturedRequest[]) => {
  // calls は複数の会話で共有されることがあるので、作成時点の件数を起点にする。
  let replies = replyTexts(calls).length
  return async (text: string): Promise<string> => {
    await agent.startTurn({ text, replyToken: `tok-${replies}` })
    await runDurableObjectAlarm(agent)
    replies += 1
    await vi.waitFor(() => expect(replyTexts(calls)).toHaveLength(replies))
    return replyTexts(calls)[replies - 1]
  }
}

afterEach(async () => {
  await cleanupAgents()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('LineChatAgent#startTurn', () => {
  it('生成を待たずに返り、その時点では返信していない', async () => {
    const agent = await stubModel('user:U1', textModel('返事'))
    const { calls } = stubLineApi()

    await agent.startTurn({ text: 'やあ', replyToken: 'tok' })

    expect(calls).toHaveLength(0)
  })

  it('アラームの発火で生成した返答を返信する', async () => {
    const agent = await stubModel('user:U1', textModel('こんにちは、AI です'))
    const { calls } = stubLineApi()

    expect(await conversation(agent, calls)('やあ')).toBe('こんにちは、AI です')
  })

  it('生成が失敗してもフォールバック文言で返信する', async () => {
    const agent = await stubModel('user:U1', failingModel())
    const { calls } = stubLineApi()

    expect(await conversation(agent, calls)('やあ')).toContain('うまく返事ができませんでした')
  })

  // LINE は空のテキストメッセージを受け付けない。
  it('モデルが空文字を返してもフォールバック文言で返信する', async () => {
    const agent = await stubModel('user:U1', textModel(''))
    const { calls } = stubLineApi()

    expect(await conversation(agent, calls)('やあ')).toContain('うまく返事ができませんでした')
  })

  // schedule のリトライ既定は 3 回で、そのままだと LINE へ重複送信される。
  it('生成が失敗しても返信は 1 回だけ', async () => {
    const agent = await stubModel('user:U1', failingModel())
    const { calls } = stubLineApi()
    await conversation(agent, calls)('やあ')

    // 追加のアラームを走らせても再送されないこと。
    await runDurableObjectAlarm(agent)
    expect(replyTexts(calls)).toHaveLength(1)
  })

  it('返答の前後の空白を落とす', async () => {
    const agent = await stubModel('user:U1', textModel('\n  はい  \n'))
    const { calls } = stubLineApi()

    expect(await conversation(agent, calls)('やあ')).toBe('はい')
  })

  it('5000 文字を超える返答は切り詰める', async () => {
    const agent = await stubModel('user:U1', textModel('あ'.repeat(6000)))
    const { calls } = stubLineApi()

    expect(await conversation(agent, calls)('やあ')).toHaveLength(5000)
  })

  it('長い日本語の返答が文字化けしない', async () => {
    // 平文 Response 経路はチャンク境界でマルチバイト文字を壊すため、その回帰テスト。
    const agent = await stubModel('user:U1', textModel('あ'.repeat(3000)))
    const { calls } = stubLineApi()

    const reply = await conversation(agent, calls)('やあ')
    expect(reply).toBe('あ'.repeat(3000))
    expect(reply).not.toContain('�')
  })
})

describe('LineChatAgent の会話履歴', () => {
  it('2 ターン目のモデル呼び出しに 1 ターン目の履歴が渡る', async () => {
    const { target, model } = await stubModelWithCalls('user:U1', '一回目', '二回目')
    const { calls } = stubLineApi()
    const say = conversation(target, calls)

    await say('ひとつめ')
    await say('ふたつめ')

    expect(model.doStreamCalls).toHaveLength(2)
    const { prompt } = model.doStreamCalls[1]
    expect(prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(JSON.stringify(prompt)).toContain('ひとつめ')
    expect(JSON.stringify(prompt)).toContain('一回目')
  })

  // reply token は 1 分で切れるので、それを超える生成は打ち切ってフォールバックに倒す。
  it('モデル呼び出しに中断シグナルを渡す', async () => {
    const { target, model } = await stubModelWithCalls('user:U1', 'はい')
    const { calls } = stubLineApi()

    await conversation(target, calls)('やあ')

    // DO の外からシグナルの状態は読めない（クロス DO の I/O 制限）ので、
    // 渡っていることだけを見る。合成そのものは test/abort.test.ts で検証している。
    expect(model.doStreamCalls[0].abortSignal).toBeDefined()
  })

  it('システムプロンプトを毎回渡し、現在時刻を含める', async () => {
    const { target, model } = await stubModelWithCalls('user:U1', 'はい')
    const { calls } = stubLineApi()

    await conversation(target, calls)('やあ')

    const system = JSON.stringify(model.doStreamCalls[0].prompt[0])
    expect(system).toContain('日本語')
    expect(system).toContain('現在の日時')
  })

  it('空の返答は次のターンの文脈にテキストを持ち込まない', async () => {
    const empty = await stubModel('user:U1', textModel(''))
    const { calls } = stubLineApi()
    await conversation(empty, calls)('やあ')

    // 空の assistant メッセージ自体は履歴に残るが、中身が空であることを確認する。
    const { target, model } = await stubModelWithCalls('user:U1', 'ふつうの返事')
    await conversation(target, calls)('もう一度')

    const assistants = model.doStreamCalls[0].prompt.filter((m) => m.role === 'assistant')
    expect(assistants.every((m) => m.content.length === 0)).toBe(true)
  })

  it('会話キーが違えば履歴は混ざらない', async () => {
    const { calls } = stubLineApi()
    const { target: user } = await stubModelWithCalls('user:U1', '個人の返事')
    await conversation(user, calls)('個人の発言')

    const { target: group, model: groupModel } = await stubModelWithCalls(
      'group:G1',
      'グループの返事',
    )
    await conversation(group, calls)('グループの発言')

    expect(JSON.stringify(groupModel.doStreamCalls[0].prompt)).not.toContain('個人の発言')
  })
})
