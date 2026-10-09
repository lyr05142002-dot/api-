import type {
  UsageMeterLimit as Limit,
  UsageMeterRange as Range,
  UsageMeterSample as Sample,
  UsageMeterTok as Tok,
  UsageMeterTurn as Turn,
} from '../types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const KEEP_MS = 8 * DAY
const MAX_TURNS = 1500
const MAX_SAMPLES = 4000

export const RANGE_MS: Record<Range, number> = { '5h': 5 * HOUR, '24h': DAY, '7d': 7 * DAY }

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** A tool result fed into the next model request of its loop. */
export type Pending = { name: string; chars: number }

export const emptyTok = (): Tok => ({ i: 0, cw: 0, cr: 0, o: 0 })

export function newTurn(id: string, sid: string, proj: string, text: string, t: number): Turn {
  return {
    id, sid, proj, text, t0: t, t1: t,
    tok: emptyTok(), cats: {}, models: {}, w: 0, usd: null,
    p5: 0, p7: 0, steps: 0, tools: 0, agents: 0,
  }
}

/**
 * Dollars per million uncached input tokens, by model family. Only the ratios
 * matter: they weigh a cheap Haiku request against an Opus one.
 */
export function priceFactor(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 1
  if (m.includes('sonnet')) return 3
  return 5
}

export function toolCat(name: string): string {
  if (name === 'Agent' || name === 'Task') return 'agent'
  if (name.startsWith('mcp__')) return 'mcp:' + (name.split('__')[1] ?? '?')
  return 'tool:' + name
}

/**
 * Splits one model request's cost over what caused it, weighted the way API
 * prices weigh tokens (cache read 0.1x, cache write 1.25x, output 5x):
 * - re-reading the cached conversation → `history`
 * - new input: the prompt on a turn's first request, else the tool results
 *   fed back since the loop's last request, by their size
 * - output: the tools it asks for (their arguments, a file it writes), else
 *   the answer and its thinking
 * - everything inside a subagent → `agent`
 */
export function attribute(a: {
  usage: Usage
  model: string
  index: number
  isSubagent: boolean
  pending: readonly Pending[]
  calls: readonly string[]
}): Record<string, number> {
  const u = a.usage
  const f = priceFactor(a.model)
  const fresh = (u.input_tokens + 1.25 * u.cache_creation_input_tokens) * f
  const reread = 0.1 * u.cache_read_input_tokens * f
  const out = 5 * u.output_tokens * f
  const cats: Record<string, number> = {}
  const add = (k: string, v: number) => {
    if (v > 0) cats[k] = (cats[k] ?? 0) + v
  }
  if (a.isSubagent) {
    add('agent', fresh + reread + out)
    return cats
  }
  add('history', reread)
  if (a.index === 0 || a.pending.length === 0) {
    add('prompt', fresh)
  } else {
    const chars = a.pending.reduce((s, p) => s + p.chars, 0)
    for (const p of a.pending) {
      add(toolCat(p.name), chars > 0 ? (fresh * p.chars) / chars : fresh / a.pending.length)
    }
  }
  if (a.calls.length === 0) add('output', out)
  else for (const c of a.calls) add(toolCat(c), out / a.calls.length)
  return cats
}

export function addInto(into: Record<string, number>, from: Record<string, number>): Record<string, number> {
  const out = { ...into }
  for (const [k, v] of Object.entries(from)) out[k] = (out[k] ?? 0) + v
  return out
}

/** A turn with one more model request counted in. */
export function withStep(t: Turn, usage: Usage, model: string, cats: Record<string, number>, now: number): Turn {
  const w = Object.values(cats).reduce((s, v) => s + v, 0)
  return {
    ...t,
    t1: now,
    steps: t.steps + 1,
    tok: {
      i: t.tok.i + usage.input_tokens,
      cw: t.tok.cw + usage.cache_creation_input_tokens,
      cr: t.tok.cr + usage.cache_read_input_tokens,
      o: t.tok.o + usage.output_tokens,
    },
    cats: addInto(t.cats, cats),
    models: addInto(t.models, { [model]: w }),
    w: t.w + w,
  }
}

export function resetMs(resetsAt: string | undefined): number | null {
  const t = resetsAt ? Date.parse(resetsAt) : NaN
  return Number.isFinite(t) ? t : null
}

/**
 * Whether the window reset at `b` comes after (1), before (-1) or is the same
 * as (0) the one reset at `a`. A new window opens only after the old one
 * resets and lasts hours, so its reset is hours later: reset times within an
 * hour of each other, or one unknown, are one window read twice.
 */
export function windowOrder(a: number | null, b: number | null): -1 | 0 | 1 {
  if (a === null || b === null || Math.abs(b - a) <= HOUR) return 0
  return b > a ? 1 : -1
}

/** How many points a window moved between two readings; a new window starts from 0. */
export function moved(prev: Limit | undefined, cur: Limit | undefined): number {
  if (!prev || !cur) return 0
  const order = windowOrder(resetMs(prev.resetsAt), resetMs(cur.resetsAt))
  if (order > 0) return cur.pct
  if (order < 0) return 0 // a stale reading of the window before
  return Math.max(0, cur.pct - prev.pct)
}

/** Shares `points` of a limit over the turns that spent them, by their weight. */
export function spread(turns: readonly Turn[], points: number, key: 'p5' | 'p7'): Turn[] {
  if (points <= 0 || turns.length === 0) return [...turns]
  const total = turns.reduce((s, t) => s + t.w, 0)
  return turns.map(t => ({
    ...t,
    [key]: t[key] + (total > 0 ? (points * t.w) / total : points / turns.length),
  }))
}

export function mergeTurns(a: readonly Turn[], b: readonly Turn[], now: number): Turn[] {
  const byId = new Map<string, Turn>()
  for (const t of [...a, ...b]) {
    const had = byId.get(t.id)
    if (!had || t.t1 > had.t1 || (t.t1 === had.t1 && t.p5 + t.p7 >= had.p5 + had.p7)) byId.set(t.id, t)
  }
  return [...byId.values()]
    .filter(t => t.t1 >= now - KEEP_MS)
    .sort((x, y) => x.t0 - y.t0)
    .slice(-MAX_TURNS)
}

export function mergeSamples(a: readonly Sample[], b: readonly Sample[], now: number): Sample[] {
  const byT = new Map<number, Sample>()
  for (const s of [...a, ...b]) byT.set(s[0], s)
  return [...byT.values()]
    .filter(s => s[0] >= now - KEEP_MS)
    .sort((x, y) => x[0] - y[0])
    .slice(-MAX_SAMPLES)
}

/** A reading worth keeping: the first, or one that differs from the last. */
export function isNewSample(last: Sample | undefined, s: Sample): boolean {
  if (!last) return true
  return last[1] !== s[1] || last[2] !== s[2] || (s[0] - last[0] > 10 * MINUTE && last[3] !== s[3])
}

/** The window's current figure: 0 once its reset time has passed. */
export function currentPct(l: Limit, now: number): number {
  return l.resetsAt && Date.parse(l.resetsAt) <= now ? 0 : l.pct
}

/** When the window that holds `now` began. */
export function windowStart(limits: readonly Limit[], kind: string, now: number): number {
  const span = kind === 'seven_day' ? 7 * DAY : 5 * HOUR
  const l = limits.find(x => x.kind === kind)
  const end = l?.resetsAt ? Date.parse(l.resetsAt) : NaN
  return Number.isFinite(end) && end > now ? end - span : now - span
}

export type Share = { key: string; w: number; points: number }

/** Where the turns since `since` spent, largest first. */
export function shares(turns: readonly Turn[], since: number, pick: (t: Turn) => Record<string, number>): Share[] {
  const w: Record<string, number> = {}
  const pts: Record<string, number> = {}
  for (const t of turns) {
    if (t.t1 < since) continue
    const parts = pick(t)
    for (const [k, v] of Object.entries(parts)) {
      w[k] = (w[k] ?? 0) + v
      if (t.w > 0) pts[k] = (pts[k] ?? 0) + (t.p5 * v) / t.w
    }
  }
  return Object.entries(w)
    .map(([key, v]) => ({ key, w: v, points: pts[key] ?? 0 }))
    .sort((x, y) => y.w - x.w)
}

/** Whether `b` was read in a later 5-hour window than `a`. */
function isRollover(a: Sample, b: Sample): boolean {
  if (a[4] != null && b[4] != null) return windowOrder(a[4], b[4]) > 0
  // Readings from 0.1.0 carry no reset time: only a fall by half reads as one.
  return b[1]! < a[1]! / 2
}

/**
 * Points of the 5-hour window spent per time bucket, from the readings.
 *
 * Counted against the highest reading of the window so far, so a reading that
 * dips (another session's, taken a moment earlier) adds nothing, and the
 * rise back to the high mark is not counted twice.
 */
export function burnBuckets(samples: readonly Sample[], from: number, to: number, n: number): number[] {
  const out = new Array<number>(n).fill(0)
  const size = (to - from) / n
  let high: Sample | undefined
  for (const s of samples) {
    if (s[1] === null) continue
    let d = 0
    if (!high || isRollover(high, s)) {
      d = high ? s[1] : 0
      high = s
    } else if (s[1] > high[1]!) {
      d = s[1] - high[1]!
      high = s
    }
    if (d > 0 && s[0] >= from && s[0] <= to) {
      const k = Math.min(n - 1, Math.floor((s[0] - from) / size))
      out[k] = out[k]! + d
    }
  }
  return out
}

export function limitsOf(rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Limit[] {
  return rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt }))
}

/** The higher of two readings of one window; a later window wins. */
export function higher(prev: Limit | undefined, cur: Limit | undefined): Limit | undefined {
  if (!prev || !cur) return cur ?? prev
  const order = windowOrder(resetMs(prev.resetsAt), resetMs(cur.resetsAt))
  if (order !== 0) return order > 0 ? cur : prev
  return cur.pct >= prev.pct ? cur : prev
}

const LABELS: Record<string, string> = {
  prompt: '你的消息 / 系统提示',
  history: '重读历史上下文',
  output: '回答与思考',
  agent: '子代理 Agent',
  other: '其他（网页聊天、别的设备、插件装上之前）',
}

export function catLabel(key: string): string {
  if (LABELS[key]) return LABELS[key]!
  if (key.startsWith('tool:')) return '工具 ' + key.slice(5)
  if (key.startsWith('mcp:')) return 'MCP · ' + key.slice(4)
  return key
}

export function modelLabel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

export function fmtTok(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k'
  return String(Math.round(n))
}

export function fmtPct(p: number): string {
  return (p >= 10 || p === 0 ? Math.round(p) : Math.round(p * 10) / 10) + '%'
}

export function fmtUsd(usd: number): string {
  return '$' + (usd >= 100 ? usd.toFixed(0) : usd >= 1 ? usd.toFixed(2) : usd.toFixed(3))
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const pad = (n: number) => String(n).padStart(2, '0')

export function fmtClock(t: number): string {
  const d = new Date(t)
  return `${d.getHours()}:${pad(d.getMinutes())}`
}

export function fmtDayClock(t: number, now: number): string {
  const d = new Date(t)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return (sameDay ? '' : WEEKDAYS[d.getDay()] + ' ') + fmtClock(t)
}

export function fmtSpan(ms: number): string {
  const m = Math.max(0, Math.round(ms / MINUTE))
  if (m < 60) return `${m} 分`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
}

/** "3 小时 44 分后重置" within a day, "周五 8:00 重置" past it. */
export function fmtReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const t = Date.parse(resetsAt)
  if (!Number.isFinite(t)) return ''
  if (t <= now) return '已重置'
  if (t - now < DAY) return `${fmtSpan(t - now)}后重置`
  return `${WEEKDAYS[new Date(t).getDay()]} ${fmtClock(t)} 重置`
}

export function fmtAgo(t: number, now: number): string {
  if (now - t < MINUTE) return '刚刚'
  return `${fmtSpan(now - t)}前`
}

export function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5 小时会话限额'
  if (kind === 'seven_day') return '每周 · 所有模型'
  if (kind === 'seven_day_opus') return '每周 · Opus'
  if (kind === 'seven_day_sonnet') return '每周 · Sonnet'
  if (kind === 'spend_limit') return '消费上限'
  return kind
}

export function statusLine(limits: readonly Limit[], ctxPct: number | null, now: number): string | undefined {
  const parts: string[] = []
  const five = limits.find(l => l.kind === 'five_hour')
  const seven = limits.find(l => l.kind === 'seven_day')
  if (five) {
    const left = five.resetsAt ? Date.parse(five.resetsAt) - now : NaN
    const when = Number.isFinite(left) && left > 0 ? ` (${Math.floor(left / HOUR)}h${pad(Math.floor((left % HOUR) / MINUTE))}m)` : ''
    parts.push(`5h ${fmtPct(currentPct(five, now))}${when}`)
  }
  if (seven) parts.push(`本周 ${fmtPct(currentPct(seven, now))}`)
  if (ctxPct !== null) parts.push(`上下文 ${ctxPct}%`)
  return parts.length ? '用量 ' + parts.join(' · ') : undefined
}
