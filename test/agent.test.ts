import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupAgents,
  failingModel,
  stubModel,
  stubModelWithCalls,
  textModel,
} from './helpers/agent-stub'

afterEach(async () => {
  await cleanupAgents()
  vi.restoreAllMocks()
})

describe('LineChatAgent#ask', () => {
  it('生成された返答を返す', async () => {
    const agent = await stubModel('user:U1', textModel('こんにちは、AI です'))
    expect(await agent.ask('やあ')).toBe('こんにちは、AI です')
  })

  it('2 ターン目のモデル呼び出しに 1 ターン目の履歴が渡る', async () => {
    const { target, model } = await stubModelWithCalls('user:U1', '一回目', '二回目')

    await target.ask('ひとつめ')
    await target.ask('ふたつめ')

    expect(model.doStreamCalls).toHaveLength(2)
    const { prompt } = model.doStreamCalls[1]
    expect(prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(JSON.stringify(prompt)).toContain('ひとつめ')
    expect(JSON.stringify(prompt)).toContain('一回目')
  })

  it('システムプロンプトを毎回渡す', async () => {
    const { target, model } = await stubModelWithCalls('user:U1', 'はい')
    await target.ask('やあ')
    expect(JSON.stringify(model.doStreamCalls[0].prompt[0])).toContain('日本語')
  })

  it('現在時刻はシステムプロンプトに入る', async () => {
    const { target, model } = await stubModelWithCalls('user:U1', 'はい')
    await target.ask('やあ')
    expect(JSON.stringify(model.doStreamCalls[0].prompt[0])).toContain('現在の日時')
  })

  it('長い日本語の返答が文字化けしない', async () => {
    // 平文 Response 経路はチャンク境界でマルチバイト文字を壊すため、その回帰テスト。
    const agent = await stubModel('user:U1', textModel('あ'.repeat(3000)))
    const reply = await agent.ask('やあ')
    expect(reply).toBe('あ'.repeat(3000))
    expect(reply).not.toContain('�')
  })

  it('返答の前後の空白を落とす', async () => {
    const agent = await stubModel('user:U1', textModel('\n  はい  \n'))
    expect(await agent.ask('やあ')).toBe('はい')
  })

  it('5000 文字を超える返答は切り詰める', async () => {
    const agent = await stubModel('user:U1', textModel('あ'.repeat(6000)))
    expect(await agent.ask('やあ')).toHaveLength(5000)
  })

  // 空文字のときは呼び出し側がフォールバック文言に倒す。LINE は空のテキストを受け付けない。
  it('モデルが空文字を返したら空文字を返す', async () => {
    const agent = await stubModel('user:U1', textModel(''))
    expect(await agent.ask('やあ')).toBe('')
  })

  it('空の返答は次のターンの文脈にテキストを持ち込まない', async () => {
    const agent = await stubModel('user:U1', textModel(''))
    await agent.ask('やあ')

    // 空の assistant メッセージ自体は履歴に残るが、中身が空であることを確認する。
    const { target, model } = await stubModelWithCalls('user:U1', 'ふつうの返事')
    await target.ask('もう一度')
    const assistants = model.doStreamCalls[0].prompt.filter((m) => m.role === 'assistant')
    expect(assistants.every((m) => m.content.length === 0)).toBe(true)
  })

  it('モデルの呼び出しが失敗したら例外を投げる', async () => {
    const agent = await stubModel('user:U1', failingModel())
    await expect(agent.ask('やあ')).rejects.toThrow()
  })

  it('会話キーが違えば履歴は混ざらない', async () => {
    const { target: user } = await stubModelWithCalls('user:U1', '個人の返事')
    await user.ask('個人の発言')

    const { target: group, model: groupModel } = await stubModelWithCalls(
      'group:G1',
      'グループの返事',
    )
    await group.ask('グループの発言')

    expect(JSON.stringify(groupModel.doStreamCalls[0].prompt)).not.toContain('個人の発言')
  })
})
