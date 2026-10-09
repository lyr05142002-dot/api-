import { describe, expect, mock, test } from 'claude-code/testing'
import type { SessionRateLimit } from 'claude-code'

import { attribute, burnBuckets, fmtReset, moved, newTurn, spread, statusLine } from '../hooks/model'

const T0 = Date.parse('2026-10-09T10:00:00Z')
const usage = (i: number, cw: number, cr: number, o: number) => ({
  input_tokens: i,
  cache_creation_input_tokens: cw,
  cache_read_input_tokens: cr,
  output_tokens: o,
})

describe('attribution', () => {
  test('a first request goes to the prompt, re-reading to history, output to the answer', async () => {
    const cats = attribute({ usage: usage(100, 1000, 10000, 200), model: 'claude-sonnet-5-5', index: 0, isSubagent: false, pending: [], calls: [] })
    expect(cats.prompt).toBe((100 + 1250) * 3)
    expect(cats.history).toBe(1000 * 3)
    expect(cats.output).toBe(1000 * 3)
  })

  test('new input after tool calls goes to those tools by result size', async () => {
    const cats = attribute({
      usage: usage(0, 3000, 0, 0),
      model: 'claude-haiku-5-5',
      index: 2,
      isSubagent: false,
      pending: [
        { name: 'Bash', chars: 300 },
        { name: 'Read', chars: 900 },
      ],
      calls: ['Edit'],
    })
    expect(cats['tool:Bash']).toBe(3750 * 0.25)
    expect(cats['tool:Read']).toBe(3750 * 0.75)
    expect(cats.prompt).toBeUndefined()
  })

  test('everything inside a subagent goes to agent', async () => {
    const cats = attribute({ usage: usage(10, 10, 10, 10), model: 'x', index: 3, isSubagent: true, pending: [{ name: 'Bash', chars: 1 }], calls: ['Read'] })
    expect(Object.keys(cats)).toEqual(['agent'])
  })

  test('limit points are shared by weight, and a new window counts from zero', async () => {
    const a = { ...newTurn('a', 's', 'p', 'a', 0), w: 1 }
    const b = { ...newTurn('b', 's', 'p', 'b', 0), w: 3 }
    const [x, y] = spread([a, b], 4, 'p5')
    expect(x!.p5).toBe(1)
    expect(y!.p5).toBe(3)
    expect(moved({ kind: 'five_hour', pct: 10, resetsAt: 'A' }, { kind: 'five_hour', pct: 12.5, resetsAt: 'A' })).toBe(2.5)
    expect(moved({ kind: 'five_hour', pct: 90, resetsAt: 'A' }, { kind: 'five_hour', pct: 3, resetsAt: 'B' })).toBe(3)
    expect(moved(undefined, { kind: 'five_hour', pct: 3 })).toBe(0)
  })

  test('burn buckets add up the rises, a rollover counts what the new window shows', async () => {
    const b = burnBuckets(
      [
        [0, 10, 1, null],
        [10, 15, 1, null],
        [20, 2, 1, null],
        [30, 4, 1, null],
      ],
      0,
      40,
      4,
    )
    expect(b).toEqual([0, 5, 2, 2])
  })

  test('reset text and status line read like the app', async () => {
    const now = T0
    expect(fmtReset(new Date(now + 3 * 3600_000 + 44 * 60_000).toISOString(), now)).toBe('3 小时 44 分后重置')
    expect(fmtReset(new Date(now - 1).toISOString(), now)).toBe('已重置')
    const line = statusLine(
      [
        { kind: 'five_hour', pct: 61, resetsAt: new Date(now + 3 * 3600_000 + 44 * 60_000).toISOString() },
        { kind: 'seven_day', pct: 10 },
      ],
      12,
      now,
    )
    expect(line).toBe('用量 5h 61% (3h44m) · 本周 10% · 上下文 12%')
  })
})

describe('in a session', () => {
  test('a turn is counted, the limits it moved are shared to it, and the pane draws it', async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on, { now: T0 })
    let usd = 0
    let rateLimits: SessionRateLimit[] = []
    const resetsAt = new Date(T0 + 4 * 3600_000).toISOString()
    const status: (string | undefined)[] = []
    on('session.id', () => ({ value: 'abcdef1234567890' }))
    on('session.usage', () => ({
      value: {
        startedAt: T0,
        context: { window: 200_000, tokens: 24_000, percent: 12 },
        rateLimits,
        cost: { usd },
      },
    }))
    on('ui.status', (_$, e) => (status.push(e.text), { value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    // The engine's own ends of the events the plugin observes.
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('tool.call', () => ({ result: 'x'.repeat(400), text: 'x'.repeat(400) }))
    let step = 0
    on('turn.step', async function* (_$, e) {
      step++
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: e.index === 0 ? [{ name: 'Bash', input: {} }] : [],
        stopReason: 'end_turn' as const,
        usage: { ...usage(10, 2000, step === 1 ? 0 : 20_000, 300), model: 'claude-opus-5-5' },
      }
    })

    await $.session.start({ cwd: '/home/me/my-app', surface: 'desktop', isInteractive: true })

    // A first reading is the baseline.
    rateLimits = [{ kind: 'five_hour', percentUsed: 58, resetsAt }, { kind: 'seven_day', percentUsed: 9.5 }]
    await $.session.measure({ context: { window: 200_000, tokens: 24_000, percent: 12 }, rateLimits, changed: ['rateLimits'] })

    await $.turn.start({ text: '帮我  修一下 登录页', turnId: 't1' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void _
    await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls' } as never)
    for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 3 })) void _
    await clock.advance(60_000)
    usd = 0.42
    await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, answer: 'done', durationMs: 60_000 })

    rateLimits = [{ kind: 'five_hour', percentUsed: 61, resetsAt }, { kind: 'seven_day', percentUsed: 10 }]
    await $.session.measure({ context: { window: 200_000, tokens: 26_000, percent: 13 }, rateLimits, cost: { usd }, changed: ['rateLimits'] })
    await clock.settle()

    expect(status[status.length - 1]).toMatch(/^用量 5h 61% \(3h59m\) · 本周 10% · 上下文 13%$/)

    const PANE = {
      component: 'Pane' as const,
      requestId: 'usage-meter',
      props: { title: 'Claude 用量', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
    }
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-meter', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: '5 小时会话限额' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /61%/ })).toBeDefined()
      await ui.press({ key: 'tab-where' })
      expect(await ui.find({ type: 'Text', text: '工具 Bash' })).toBeDefined()
      await ui.press({ key: 'tab-time' })
      expect(await ui.find({ type: 'Text', text: '限额走势' })).toBeDefined()
      await ui.press({ key: 'tab-turns' })
      // The turn moved the 5-hour window from 58% to 61%, all of it its own.
      expect(await ui.find({ type: 'Text', text: /「帮我 修一下 登录页」/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '+3%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /my-app · .* 2 次请求 · 1 次工具 · \$0\.420/ })).toBeDefined()
      await ui.press({ key: 'tab-now' })
      await ui.unmount()
    }
  })
})
