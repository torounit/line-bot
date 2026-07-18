import { describe, expect, it } from 'vitest'
import { currentTimeMessage, systemPrompt } from '../src/ai/prompt'

describe('systemPrompt', () => {
  it('呼び出しごとに変わらない', () => {
    expect(systemPrompt()).toBe(systemPrompt())
  })

  it('prefix cache を壊さないよう可変の値を含まない', () => {
    // 年号が入っていれば時刻が紛れ込んでいる。
    expect(systemPrompt()).not.toMatch(/\d{4}年/)
  })

  it('日本語で答えるよう指示する', () => {
    expect(systemPrompt()).toContain('日本語')
  })

  it('LINE で崩れる Markdown を使わないよう指示する', () => {
    expect(systemPrompt()).toContain('Markdown')
  })
})

describe('currentTimeMessage', () => {
  it('UTC ではなく JST に変換した日時を含む', () => {
    // 2026-07-18T15:00:00Z は JST では翌日 2026-07-19 の 0 時。
    const message = currentTimeMessage(new Date('2026-07-18T15:00:00Z'))
    expect(message.content).toContain('2026年7月19日')
    expect(message.content).toContain('JST')
  })

  it('system ロールで返す', () => {
    expect(currentTimeMessage(new Date('2026-07-18T15:00:00Z')).role).toBe('system')
  })
})
