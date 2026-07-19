import { describe, expect, it } from 'vitest'
import { abortAfter } from '../src/abort'

describe('abortAfter', () => {
  it('指定時間で中断する', async () => {
    const signal = abortAfter(10)
    expect(signal.aborted).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(signal.aborted).toBe(true)
  })

  it('渡されたシグナルが先に中断すればそちらで中断する', () => {
    const controller = new AbortController()
    const signal = abortAfter(60_000, controller.signal)

    expect(signal.aborted).toBe(false)
    controller.abort()
    expect(signal.aborted).toBe(true)
  })

  it('シグナルが渡されなくても機能する', () => {
    expect(abortAfter(60_000).aborted).toBe(false)
  })
})
