import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

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
    const A = '2026-10-09T15:00:00Z'
    const B = '2026-10-09T20:30:00Z'
    expect(moved({ kind: 'five_hour', pct: 10, resetsAt: A }, { kind: 'five_hour', pct: 12.5, resetsAt: A })).toBe(2.5)
    expect(moved({ kind: 'five_hour', pct: 90, resetsAt: A }, { kind: 'five_hour', pct: 3, resetsAt: B })).toBe(3)
    expect(moved(undefined, { kind: 'five_hour', pct: 3 })).toBe(0)
    // A reset time a second off, or missing, is the same window: only the rise counts.
    expect(moved({ kind: 'five_hour', pct: 60, resetsAt: A }, { kind: 'five_hour', pct: 61, resetsAt: '2026-10-09T15:00:01Z' })).toBe(1)
    expect(moved({ kind: 'five_hour', pct: 60, resetsAt: A }, { kind: 'five_hour', pct: 61 })).toBe(1)
    // A stale reading of the window before claims nothing.
    expect(moved({ kind: 'five_hour', pct: 3, resetsAt: B }, { kind: 'five_hour', pct: 90, resetsAt: A })).toBe(0)
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

  test('a dipping reading adds nothing, and the rise back to the high mark is not counted twice', async () => {
    const b = burnBuckets(
      [
        [0, 61, 1, null, 500],
        [10, 60, 1, null, 500],
        [20, 62, 1, null, 500],
      ],
      0,
      30,
      3,
    )
    expect(b).toEqual([0, 0, 1])
  })

  test('a reset time hours later is a new window, whatever the figures', async () => {
    const b = burnBuckets(
      [
        [0, 40, 1, null, 5 * 3600_000],
        [10, 30, 1, null, 10 * 3600_000],
      ],
      0,
      20,
      2,
    )
    expect(b).toEqual([0, 30])
  })

  test('reset times a second apart are one window, so nothing is counted twice', async () => {
    const r = 5 * 3600_000
    const b = burnBuckets(
      [
        [0, 60, 1, null, r],
        [10, 60.1, 1, null, r + 1000],
        [20, 60.2, 1, null, r],
      ],
      0,
      30,
      3,
    )
    expect(b.map(x => Math.round(x * 10) / 10)).toEqual([0, 0.1, 0.1])
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

const RESETS = new Date(T0 + 4 * 3600_000).toISOString()
const PANE = {
  component: 'Pane' as const,
  requestId: 'usage-meter',
  props: { title: 'Claude 用量', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
}
const limits = (five: number, seven: number): SessionRateLimit[] => [
  { kind: 'five_hour', percentUsed: five, resetsAt: RESETS },
  { kind: 'seven_day', percentUsed: seven },
]

/** A session with the engine's ends mocked: one tool call per turn, then an answer. */
function session($: Engine, on: On, stored: Record<string, unknown> = {}) {
  mock.store(on, stored)
  const clock = mock.clock(on, { now: T0 })
  const world = { usd: 0, rateLimits: [] as SessionRateLimit[], status: [] as (string | undefined)[], toasts: [] as string[] }
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('session.usage', () => ({
    value: { startedAt: T0, context: { window: 200_000, tokens: 24_000, percent: 12 }, rateLimits: world.rateLimits, cost: { usd: world.usd } },
  }))
  on('ui.status', (_$, e) => (world.status.push(e.text), { value: undefined }))
  on('ui.toast', (_$, e) => (world.toasts.push(e.text), { value: undefined }))
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
  return {
    clock,
    world,
    start: () => $.session.start({ cwd: '/home/me/my-app', surface: 'desktop', isInteractive: true }),
    measure: async (five: number, seven: number) => {
      world.rateLimits = limits(five, seven)
      await $.session.measure({ context: { window: 200_000, tokens: 26_000, percent: 13 }, rateLimits: world.rateLimits, cost: { usd: world.usd }, changed: ['rateLimits'] })
    },
    turn: async (text: string, id: string, usd: number) => {
      await $.turn.start({ text, turnId: id })
      for await (const _ of $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void _
      await $.tool.call({ tool: 'Bash', tool_use_id: `${id}-u1`, command: 'ls' } as never)
      for await (const _ of $.turn.step({ turnId: id, index: 1, model: 'claude-opus-5-5', messageCount: 3 })) void _
      await clock.advance(60_000)
      world.usd = usd
      await $.turn.complete({ turnId: id, reason: 'answer', isAborted: false, answer: 'done', durationMs: 60_000 })
    },
  }
}

describe('in a session', () => {
  test('a turn is counted, the limits it moved are shared to it, and the pane draws it', async ($, on) => {
    const s = session($, on)
    await s.start()
    await s.measure(58, 9.5) // a first reading is the baseline
    await s.turn('帮我  修一下 登录页', 't1', 0.42)
    await s.measure(61, 10)
    await s.clock.settle()

    expect(s.world.status[s.world.status.length - 1]).toMatch(/^用量 5h 61% \(3h59m\) · 本周 10% · 上下文 13%$/)

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

  test('points another session already claimed are not claimed again', async ($, on) => {
    // Another session read 61% a moment ago; this one last saw nothing.
    const s = session($, on, { last: { t: T0, five: { kind: 'five_hour', pct: 61, resetsAt: RESETS } } })
    await s.start()
    await s.turn('第二个会话', 't1', 0.1)
    await s.measure(62, 10)
    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...PANE })
    await ui.press({ key: 'tab-turns' })
    expect(await ui.find({ type: 'Text', text: '+1%' })).toBeDefined()
    await ui.unmount()
  })

  test('a few minutes of pause before a prompt still counts toward that turn', async ($, on) => {
    const s = session($, on, { last: { t: T0 - 5 * 60_000, five: { kind: 'five_hour', pct: 58, resetsAt: RESETS } } })
    await s.start()
    await s.turn('想了一会儿再问', 't1', 0.1)
    await s.measure(61, 10)
    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...PANE })
    await ui.press({ key: 'tab-turns' })
    expect(await ui.find({ type: 'Text', text: '+3%' })).toBeDefined()
    await ui.unmount()
  })

  test('a reading without limits does not pass stored figures off as new', async ($, on) => {
    // The last session saw 85% of a window that has since reset.
    const old = new Date(T0 - 3600_000).toISOString()
    const s = session($, on, { live: { limits: [{ kind: 'five_hour', pct: 85, resetsAt: old }], limitsAt: T0 - 2 * 3600_000, ctxTokens: null, ctxWindow: null, ctxPct: null, usd: null } })
    await s.start()
    await $.session.measure({ context: { window: 200_000, tokens: 30_000, percent: 15 }, rateLimits: [], changed: ['context'] })
    expect(s.world.toasts).toEqual([])
    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...PANE })
    // The expired window reads 0%, and the context moved on.
    expect(await ui.find({ type: 'Text', text: /已重置\s+0%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /30k \/ 200k · 15%/ })).toBeDefined()
    await ui.press({ key: 'tab-time' })
    expect(await ui.find({ type: 'Text', text: /读数还少/ })).toBeDefined()
    await ui.unmount()
  })

  test('what moved during an idle gap goes to 「其他」, not to the next turn', async ($, on) => {
    // The newest reading is 45 minutes older than the turn: the web app may have spent since.
    const s = session($, on, { last: { t: T0 - 45 * 60_000, five: { kind: 'five_hour', pct: 50, resetsAt: RESETS } } })
    await s.start()
    await s.turn('空闲之后', 't1', 0.1)
    await s.measure(61, 10)
    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...PANE })
    await ui.press({ key: 'tab-turns' })
    expect(await ui.find({ type: 'Text', text: /^\+/ })).toBeUndefined()
    await ui.press({ key: 'tab-where' })
    expect(await ui.find({ type: 'Text', text: /^其他/ })).toBeDefined()
    await ui.unmount()
  })
})
