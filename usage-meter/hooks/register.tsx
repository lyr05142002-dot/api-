import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, TurnUsage } from 'claude-code'

import type {
  UsageMeterCtxCat as CtxCat,
  UsageMeterLast as Last,
  UsageMeterLive as Live,
  UsageMeterRange as Range,
  UsageMeterSample as Sample,
  UsageMeterTab as Tab,
  UsageMeterTurn as Turn,
} from '../types'
import { burnChartSvg, levels, limitsChartSvg, meterSvg, meterText, sparkText } from './charts'
import {
  KEEP_MS,
  MINUTE,
  RANGE_MS,
  type Pending,
  type Share,
  attribute,
  burnBuckets,
  catLabel,
  currentPct,
  fmtAgo,
  fmtDayClock,
  fmtPct,
  fmtReset,
  fmtTok,
  fmtUsd,
  higher,
  isNewSample,
  limitLabel,
  limitsOf,
  mergeSamples,
  mergeTurns,
  modelLabel,
  moved,
  newTurn,
  shares,
  spread,
  statusLine,
  withStep,
  windowStart,
} from './model'

const PANE = 'usage-meter'
const TITLE = 'Claude 用量'

const liveA = atom({ plugin: 'usage-meter', key: 'live' } as const, {
  limits: [],
  limitsAt: 0,
  ctxTokens: null,
  ctxWindow: null,
  ctxPct: null,
  usd: null,
})
const samplesA = atom({ plugin: 'usage-meter', key: 'samples' } as const, [])
const mineA = atom({ plugin: 'usage-meter', key: 'mine' } as const, [])
const turnsA = atom({ plugin: 'usage-meter', key: 'turns' } as const, [])
const currentA = atom({ plugin: 'usage-meter', key: 'current' } as const, null)
const ctxCatsA = atom({ plugin: 'usage-meter', key: 'ctxCats' } as const, null)
const viewA = atom({ plugin: 'usage-meter', key: 'view' } as const, { tab: 'now', range: '5h' })
const nowA = atom({ plugin: 'usage-meter', key: 'now' } as const, 0)

const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const totalTok = (t: Turn) => t.tok.i + t.tok.cw + t.tok.cr + t.tok.o

/** The session's first 8 characters, and its project folder's name. */
let sid = 'session'
let proj = ''
/** Tool results each loop has produced since its last model request. */
const pending = new Map<string, Pending[]>()
/** Finished turns whose share of the limits the next reading settles. */
const unsettled = new Set<string>()
let usdAtStart: number | null = null
const warned = new Set<string>()

/**
 * How long before the work being counted the previous reading may have been
 * taken: a pause between prompts is still this work's. Older, the gap held
 * idle time in which the web app or another device may have spent, so what
 * moved then is left to 「其他」 rather than to this work.
 */
const SLACK_MS = 30 * MINUTE

// One mutation at a time, so a reading never lands between a turn leaving
// `current` and joining `turns`.
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

/**
 * Every session's turns and readings: each session stores its own under
 * `turns:<sid>` and `samples:<sid>` (0.1.0 kept them all under `turns` and
 * `samples`). Keys that hold nothing newer than the retention go.
 */
async function loadAll($: EngineInterface, prune: boolean): Promise<void> {
  const now = await $.clock.now()
  let turns: Turn[] = []
  let samples: Sample[] = []
  for (const key of await $.store.keys()) {
    const isTurns = key === 'turns' || key.startsWith('turns:')
    const isSamples = key === 'samples' || key.startsWith('samples:')
    if (!isTurns && !isSamples) continue
    const value = await $.store.get(key)
    if (isTurns) {
      const list = asArray<Turn>(value)
      if (prune && !list.some(t => t.t1 >= now - KEEP_MS)) await $.store.delete(key)
      else turns = mergeTurns(turns, list, now)
    } else {
      const list = asArray<Sample>(value)
      if (prune && !list.some(x => x[0] >= now - KEEP_MS)) await $.store.delete(key)
      else samples = mergeSamples(samples, list, now)
    }
  }
  await update($, turnsA, list => mergeTurns(turns, list, now))
  await update($, samplesA, list => mergeSamples(samples, list, now))
}

/** Stores this session's own records, then takes in what other sessions stored. */
async function persist($: EngineInterface, isEnding = false): Promise<void> {
  try {
    const now = await $.clock.now()
    await $.store.set(`turns:${sid}`, mergeTurns([], (await read($, turnsA)).filter(t => t.sid === sid), now))
    await $.store.set(`samples:${sid}`, mergeSamples([], await read($, mineA), now))
    const live = await read($, liveA)
    const stored = (await $.store.get('live')) as Live | undefined
    if (!stored || !(stored.limitsAt > live.limitsAt)) await $.store.set('live', live)
    if (!isEnding) await loadAll($, false)
  } catch {
    // The next turn stores again.
  }
}

async function showStatus($: EngineInterface): Promise<void> {
  const live = await read($, liveA)
  $.ui.status(statusLine(live.limits, live.ctxPct, await $.clock.now()))
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowA, () => now)
  await showStatus($)
}

async function recordStep($: EngineInterface, agentId: string | undefined, index: number, usage: TurnUsage, calls: string[]): Promise<void> {
  const loop = agentId ?? 'main'
  const cats = attribute({
    usage,
    model: usage.model,
    index,
    isSubagent: agentId !== undefined,
    pending: pending.get(loop) ?? [],
    calls,
  })
  pending.set(loop, [])
  const now = await $.clock.now()
  await serial(async () => {
    const cur = await read($, currentA)
    if (cur) {
      await update($, currentA, t => (t ? withStep(t, usage, usage.model, cats, now) : t))
      return
    }
    // Work with no prompt of yours running: background agents and the like.
    await update($, turnsA, list => {
      const at = list.findLastIndex(t => t.id.startsWith(`bg:${sid}:`) && now - t.t1 < 5 * MINUTE)
      const base = at >= 0 ? list[at]! : newTurn(`bg:${sid}:${now}`, sid, proj, '（后台任务 / 子代理）', now)
      unsettled.add(base.id)
      const next = withStep(base, usage, usage.model, cats, now)
      return at >= 0 ? list.map((t, i) => (i === at ? next : t)) : [...list, next]
    })
  })
}

async function finishTurn($: EngineInterface, turnId: string): Promise<void> {
  const now = await $.clock.now()
  const usd = (await $.session.usage()).cost?.usd
  await serial(async () => {
    const cur = await read($, currentA)
    if (!cur || cur.id !== `${sid}:${turnId}`) return
    const done: Turn = {
      ...cur,
      t1: now,
      usd: usd !== undefined && usdAtStart !== null ? Math.max(0, usd - usdAtStart) : null,
    }
    unsettled.add(done.id)
    await update($, turnsA, list => [...list, done])
    await update($, currentA, () => null)
  })
}

async function readContext($: EngineInterface): Promise<void> {
  const b = await $.session.usage({ breakdown: 'summary' })
  const cats: CtxCat[] = (b.context.breakdown?.categories ?? [])
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind }))
  await update($, ctxCatsA, () => cats)
}

/**
 * Takes a reading: shares what the limits moved since the newest reading any
 * session took over this session's turns that moved them, so two sessions
 * open at once never both claim the same points.
 */
async function measure($: EngineInterface, e: SessionMeasureInput): Promise<void> {
  const now = await $.clock.now()
  const read5 = limitsOf(e.rateLimits)
  const limits = read5.length ? read5 : (await read($, liveA)).limits
  const five = limits.find(l => l.kind === 'five_hour')
  const seven = limits.find(l => l.kind === 'seven_day')

  if (read5.length) {
    const prev = (await $.store.get('last')) as Last | undefined
    const cur = await read($, currentA)
    const done = (await read($, turnsA)).filter(t => unsettled.has(t.id))
    const targets = cur ? [...done, cur] : done
    const since = Math.min(...targets.map(t => t.t0))
    const isCovered = prev !== undefined && targets.length > 0 && prev.t >= since - SLACK_MS
    const d5 = isCovered ? moved(prev.five, five) : 0
    const d7 = isCovered ? moved(prev.seven, seven) : 0
    if (d5 > 0 || d7 > 0) {
      const byId = new Map(spread(spread(targets, d5, 'p5'), d7, 'p7').map(t => [t.id, t]))
      if (cur) await update($, currentA, t => (t ? (byId.get(t.id) ?? t) : t))
      if (done.length) await update($, turnsA, list => list.map(t => byId.get(t.id) ?? t))
    }
    unsettled.clear()
    const last: Last = { t: now, five: higher(prev?.five, five), seven: higher(prev?.seven, seven) }
    await $.store.set('last', last)
  }

  await update($, liveA, old => ({
    limits,
    limitsAt: read5.length ? now : old.limitsAt,
    ctxTokens: e.context.tokens ?? null,
    ctxWindow: e.context.window,
    ctxPct: e.context.percent ?? null,
    usd: e.cost?.usd ?? old.usd,
  }))
  const r5 = five?.resetsAt ? Date.parse(five.resetsAt) : NaN
  const sample: Sample = [now, five?.pct ?? null, seven?.pct ?? null, e.context.percent ?? null, Number.isFinite(r5) ? r5 : null]
  const isNew = isNewSample((await read($, mineA)).at(-1), sample)
  if (isNew) {
    await update($, mineA, list => [...list, sample])
    await update($, samplesA, list => [...list, sample])
  }

  for (const th of [80, 90, 100]) {
    const key = `${five?.resetsAt}:${th}`
    if (five && five.pct >= th && !warned.has(key)) {
      warned.add(key)
      $.ui.toast(`5 小时限额已用 ${fmtPct(five.pct)}，${fmtReset(five.resetsAt, now)}`)
    }
  }
}

async function start($: EngineInterface, cwd: string): Promise<void> {
  sid = (await $.session.id()).slice(0, 8)
  proj = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
  const now = await $.clock.now()

  await loadAll($, true)
  const mine = asArray<Sample>(await $.store.get(`samples:${sid}`))
  await update($, mineA, list => mergeSamples(mine, list, now))
  const storedLive = (await $.store.get('live')) as Live | undefined

  // Until this session's first reply, show the last figures any session read.
  const usage = await $.session.usage()
  await update($, liveA, live => ({
    ...live,
    ...(storedLive && Array.isArray(storedLive.limits) ? storedLive : {}),
    ...(usage.rateLimits.length ? { limits: limitsOf(usage.rateLimits), limitsAt: now } : {}),
    ctxTokens: usage.context.tokens ?? null,
    ctxWindow: usage.context.window,
    ctxPct: usage.context.percent ?? null,
    usd: usage.cost?.usd ?? null,
  }))
  await update($, nowA, () => now)
  await showStatus($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await start($, e.cwd)
    await $.command.register({ name: 'usage-meter', description: '打开 Claude 用量面板（限额、消耗曲线、消耗去向）' })
    void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(MINUTE, () => void tick($).catch(() => undefined))
    return started
  })

  on('command.run', { command: 'usage-meter' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    const live = await read($, liveA)
    const now = await $.clock.now()
    return { text: statusLine(live.limits, live.ctxPct, now) ?? '用量面板已打开，还没有读到限额。' }
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const text = e.text.trim().replace(/\s+/g, ' ').slice(0, 80) || '（自动继续）'
    pending.set('main', [])
    usdAtStart = (await $.session.usage()).cost?.usd ?? null
    await serial(() => update($, currentA, () => newTurn(`${sid}:${e.turnId}`, sid, proj, text, now)))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const loop = e.agentId ?? 'main'
    const chars = ran.deny !== undefined ? ran.deny.length : (ran.text?.length ?? 0)
    pending.set(loop, [...(pending.get(loop) ?? []), { name: String(e.tool), chars }])
    if (!e.agentId) {
      // Not awaited: the result goes back to the model without waiting on it.
      void serial(() => update($, currentA, t => (t ? { ...t, tools: t.tools + 1 } : t))).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    if (res.usage) {
      try {
        await recordStep($, e.agentId, e.index, res.usage, res.toolUses.map(u => u.name))
      } catch {
        // Counting never gets in the way of the turn.
      }
    }
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId) {
      await serial(() => update($, currentA, t => (t ? { ...t, agents: t.agents + 1 } : t)))
      return res
    }
    await finishTurn($, e.turnId)
    void persist($)
    void readContext($).catch(() => undefined)
    return res
  })

  on('session.measure', async ($, e, next) => {
    await serial(() => measure($, e))
    await showStatus($)
    // Mid-turn readings are stored with the turn; between turns, store now.
    if ((await read($, currentA)) === null) void persist($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await persist($, true)
    return next(e)
  })

  // ---------------------------------------------------------------- drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : null
    await read($, nowA) // redraws every minute, for the countdowns
    const now = await $.clock.now()
    const view = await read($, viewA)
    const live = await read($, liveA)
    const turns = await read($, turnsA)
    const current = await read($, currentA)
    const all = current ? [...turns, current] : turns
    const cols = Math.max(20, e.props.bodyColumns)

    const meter = (pct: number, isLimit: boolean, alt: string) =>
      Svg ? <Svg source={meterSvg(pct, isLimit)} alt={alt} /> : <Text color={isLimit && pct >= 80 ? 'warning' : 'claude'}>{meterText(pct, Math.min(40, cols - 2))}</Text>

    const row = (label: string, right: string, bold = false) => (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text bold={bold} wrap="truncate-end">{label}</Text>
        <Text dimColor>{right}</Text>
      </Box>
    )

    const tabs: [Tab, string][] = [
      ['now', '概览'],
      ['time', '时间线'],
      ['where', '去向'],
      ['turns', '每轮'],
    ]
    const tabBar = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {tabs.map(([tab, label], i) => (
          <Button
            key={`tab-${tab}`}
            label={label}
            hotkey={String(i + 1)}
            variant={view.tab === tab ? 'primary' : 'secondary'}
            onPress={() => update($, viewA, v => ({ ...v, tab }))}
          />
        ))}
      </Box>
    )

    const ranges: [Range, string][] = [
      ['5h', view.tab === 'where' ? '本窗口' : '5 小时'],
      ['24h', '24 小时'],
      ['7d', '7 天'],
    ]
    const rangeBar = (
      <Box flexDirection="row" gap={1}>
        {ranges.map(([range, label]) => (
          <Button
            key={`range-${range}`}
            label={label}
            dimColor={view.range !== range}
            variant={view.range === range ? 'primary' : 'secondary'}
            onPress={() => update($, viewA, v => ({ ...v, range }))}
          />
        ))}
      </Box>
    )

    const fivePct = (() => {
      const f = live.limits.find(l => l.kind === 'five_hour')
      return f ? currentPct(f, now) : null
    })()
    const since =
      view.range === '5h' ? windowStart(live.limits, 'five_hour', now) : now - RANGE_MS[view.range]

    const shareRows = (list: Share[], label: (k: string) => string, withPoints: boolean, extra?: Share) => {
      const total = list.reduce((s, x) => s + x.w, 0)
      const top = list.slice(0, 8)
      const rest = list.slice(8).reduce((s, x) => ({ ...s, w: s.w + x.w, points: s.points + x.points }), { key: '其余', w: 0, points: 0 })
      const rows = rest.w > 0 ? [...top, rest] : top
      return (
        <Box flexDirection="column" gap={0}>
          {rows.map(x => {
            const pct = total > 0 ? (x.w / total) * 100 : 0
            return (
              <Box key={`share-${x.key}`} flexDirection="column">
                {row(label(x.key), `${fmtPct(pct)}${withPoints && x.points >= 0.05 ? ` · ≈${fmtPct(x.points)} 限额` : ''}`)}
                {meter(pct, false, `${label(x.key)} ${fmtPct(pct)}`)}
              </Box>
            )
          })}
          {extra && extra.points >= 0.5 && row(label(extra.key), `≈${fmtPct(extra.points)} 限额`)}
        </Box>
      )
    }

    let body
    if (view.tab === 'now') {
      const ctx = live.ctxPct ?? 0
      const ctxRight =
        live.ctxTokens !== null && live.ctxWindow ? `${fmtTok(live.ctxTokens)} / ${fmtTok(live.ctxWindow)} · ${ctx}%` : `${ctx}%`
      const mine = all.filter(t => t.sid === sid)
      const sessionTok = mine.reduce((s, t) => s + totalTok(t), 0)
      const inWindow = shares(all, windowStart(live.limits, 'five_hour', now), t => t.cats)
      const top = inWindow.slice(0, 3)
      const topW = inWindow.reduce((s, x) => s + x.w, 0)
      body = (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            {row('上下文窗口', ctxRight, true)}
            {meter(ctx, false, `上下文窗口 ${ctx}%`)}
          </Box>
          <Text dimColor>套餐用量上限</Text>
          {live.limits.length === 0 && (
            <Text dimColor>还没读到限额：Claude 回复一次就会显示。用 API Key 计费的账号没有这两条限额。</Text>
          )}
          {live.limits.map(l => {
            const pct = currentPct(l, now)
            const warn = pct >= 95 ? '⛔ ' : pct >= 80 ? '⚠ ' : ''
            return (
              <Box key={`limit-${l.kind}`} flexDirection="column">
                {row(warn + limitLabel(l.kind), `${fmtReset(l.resetsAt, now)}  ${fmtPct(pct)}`, true)}
                {meter(pct, true, `${limitLabel(l.kind)} ${fmtPct(pct)}`)}
              </Box>
            )
          })}
          {current && (
            <Text>
              <Text color="claude">● 进行中</Text> 「{current.text.slice(0, 40)}」 {current.steps} 次请求 · {fmtTok(totalTok(current))} tokens
              {current.p5 > 0 ? ` · +${fmtPct(current.p5)}` : ''}
            </Text>
          )}
          {top.length > 0 && (
            <Box flexDirection="column">
              <Text bold>本窗口消耗最多</Text>
              {top.map(x => row(catLabel(x.key), fmtPct(topW > 0 ? (x.w / topW) * 100 : 0)))}
            </Box>
          )}
          <Text dimColor>
            本会话 {mine.length} 轮 · {fmtTok(sessionTok)} tokens{live.usd !== null ? ` · 按 API 价约 ${fmtUsd(live.usd)}` : ''}
          </Text>
          <Text dimColor>
            {live.limitsAt ? `限额读取于 ${fmtAgo(live.limitsAt, now)}。` : ''}限额只随 Claude 的回复刷新，网页聊天的消耗会在下次回复时一起显示。
          </Text>
        </Box>
      )
    } else if (view.tab === 'time') {
      const span = RANGE_MS[view.range]
      const from = now - span
      const samples = await read($, samplesA)
      const n = view.range === '5h' ? 30 : view.range === '24h' ? 24 : 28
      const burn = burnBuckets(samples, from, now, n)
      const size = span / n
      const tips = burn.map((_, k) => {
        const a = from + k * size
        const inBucket = all.filter(t => t.t1 >= a && t.t1 < a + size)
        if (!inBucket.length) return ''
        const big = inBucket.reduce((x, y) => (y.w > x.w ? y : x))
        return `${inBucket.length} 轮 · ${fmtTok(inBucket.reduce((s, t) => s + totalTok(t), 0))} tokens · 最大「${big.text.slice(0, 24)}」`
      })
      const spent = burn.reduce((s, v) => s + v, 0)
      body = (
        <Box flexDirection="column" gap={1}>
          {rangeBar}
          <Box flexDirection="column">
            <Text bold>限额走势</Text>
            <Box flexDirection="row" gap={2}>
              <Text>
                <Text color="#2a78d6">■</Text> 5 小时会话
              </Text>
              <Text>
                <Text color="#eb6834">■</Text> 每周
              </Text>
            </Box>
            {Svg ? (
              <Svg source={limitsChartSvg(samples, from, now, now)} alt="5 小时和每周限额的使用率随时间变化" isInteractive />
            ) : (
              <Box flexDirection="column">
                <Text>5h  {sparkText(levels(samples, 1, from, now, Math.min(48, cols - 6)), 100)}</Text>
                <Text>周  {sparkText(levels(samples, 2, from, now, Math.min(48, cols - 6)), 100)}</Text>
              </Box>
            )}
          </Box>
          <Box flexDirection="column">
            {row('每个时段用掉的 5 小时限额', `合计 +${fmtPct(spent)}`, true)}
            {Svg ? (
              <Svg source={burnChartSvg(burn, from, now, now, tips)} alt={`每个时段用掉的 5 小时限额，合计 ${fmtPct(spent)}`} isInteractive />
            ) : (
              <Text>{sparkText(burn, Math.max(1, ...burn))}</Text>
            )}
            <Text dimColor>
              {fmtDayClock(from, now)} → 现在 · 鼠标悬停看每段的轮数和最耗的一条消息
            </Text>
          </Box>
          {samples.length < 2 && <Text dimColor>读数还少：再和 Claude 聊几轮，曲线就会出来。</Text>}
        </Box>
      )
    } else if (view.tab === 'where') {
      const cats = shares(all, since, t => t.cats)
      const points = cats.reduce((s, x) => s + x.points, 0)
      const other: Share | undefined =
        view.range === '5h' && fivePct !== null ? { key: 'other', w: 0, points: Math.max(0, fivePct - points) } : undefined
      const byProj = shares(all, since, t => ({ [t.proj || '（未知）']: t.w }))
      const byModel = shares(all, since, t => t.models)
      const ctxCats = await read($, ctxCatsA)
      const history = cats.find(x => x.key === 'history')
      const catTotal = cats.reduce((s, x) => s + x.w, 0)
      body = (
        <Box flexDirection="column" gap={1}>
          {rangeBar}
          {cats.length === 0 && <Text dimColor>这段时间还没有记录。插件装上之后的每一轮对话都会被记下来。</Text>}
          {cats.length > 0 && (
            <Box flexDirection="column">
              <Text bold>花在了哪里</Text>
              {shareRows(cats, catLabel, true, other)}
            </Box>
          )}
          {history && catTotal > 0 && history.w / catTotal > 0.4 && (
            <Text color="warning">
              提示：「重读历史上下文」占了 {fmtPct((history.w / catTotal) * 100)}。对话越长，每次回复都要把前面的内容再读一遍；换话题时用 /clear，或用 /compact 压缩。
            </Text>
          )}
          {byProj.length > 1 && (
            <Box flexDirection="column">
              <Text bold>按项目</Text>
              {shareRows(byProj, k => k, true)}
            </Box>
          )}
          {byModel.length > 0 && (
            <Box flexDirection="column">
              <Text bold>按模型</Text>
              {shareRows(byModel, modelLabel, false)}
            </Box>
          )}
          {ctxCats && ctxCats.length > 0 && (
            <Box flexDirection="column">
              <Text bold>当前上下文里装了什么</Text>
              {ctxCats.map(c => {
                const pct = live.ctxWindow ? (c.tokens / live.ctxWindow) * 100 : 0
                return (
                  <Box key={`ctx-${c.name}`} flexDirection="column">
                    {row(c.name, `${fmtTok(c.tokens)} · ${fmtPct(pct)}`)}
                    {meter(pct, false, `${c.name} ${fmtTok(c.tokens)} tokens`)}
                  </Box>
                )
              })}
            </Box>
          )}
          <Text dimColor>比例按 API 价格给 token 加权估算（缓存读 0.1×、缓存写 1.25×、输出 5×，Opus &gt; Sonnet &gt; Haiku）。</Text>
        </Box>
      )
    } else {
      const list = [...all].sort((a, b) => b.t0 - a.t0).slice(0, 30)
      body = (
        <Box flexDirection="column" gap={1}>
          {list.length === 0 && <Text dimColor>还没有记录。</Text>}
          {list.map(t => {
            const top = shares([t], 0, x => x.cats)[0]
            const isLive = current?.id === t.id
            return (
              <Box key={`turn-${t.id}`} flexDirection="column">
                {row(`${isLive ? '● ' : ''}${fmtDayClock(t.t0, now)} 「${t.text}」`, t.p5 >= 0.05 ? `+${fmtPct(t.p5)}` : '', true)}
                <Text dimColor wrap="truncate-end">
                  {t.proj} · {fmtTok(totalTok(t))} tokens · {t.steps} 次请求{t.tools ? ` · ${t.tools} 次工具` : ''}
                  {t.agents ? ` · ${t.agents} 个子代理` : ''}
                  {t.usd !== null ? ` · ${fmtUsd(t.usd)}` : ''}
                  {top ? ` · 多在${catLabel(top.key)}` : ''}
                </Text>
              </Box>
            )
          })}
          <Text dimColor>右边的 +x% 是这一轮让 5 小时限额涨了多少。</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabBar}
        {body}
      </Box>
    )
  })
}
