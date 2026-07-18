import { describe, expect, it } from 'vitest'
import { systemPrompt } from '../src/ai/prompt'

describe('systemPrompt', () => {
  it('UTC ではなく JST に変換した日時を含む', () => {
    // 2026-07-18T15:00:00Z は JST では翌日 2026-07-19 の 0 時。
    const prompt = systemPrompt(new Date('2026-07-18T15:00:00Z'))
    expect(prompt).toContain('2026年7月19日')
    expect(prompt).toContain('JST')
  })

  it('日本語で答えるよう指示する', () => {
    expect(systemPrompt(new Date('2026-07-18T15:00:00Z'))).toContain('日本語')
  })

  it('LINE で崩れる Markdown を使わないよう指示する', () => {
    expect(systemPrompt(new Date('2026-07-18T15:00:00Z'))).toContain('Markdown')
  })
})
