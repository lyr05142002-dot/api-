// Recommends a model for the prompt being typed, from what it asks, the
// project it is asked in, and how much of the limits is left. Local rules
// only: the advice itself never spends a token.

export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'

const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable']

export const TIER_INFO: Record<Tier, { name: string; use: string; price: number; command: string }> = {
  haiku: { name: 'Haiku 5.5', use: '简单问答、解释、改小地方', price: 0.1, command: '/model haiku' },
  sonnet: { name: 'Sonnet 5.5', use: '日常写代码、修 bug、加功能', price: 2, command: '/model sonnet' },
  opus: { name: 'Opus 5.5', use: '复杂改动、排查难题、跨文件重构', price: 4, command: '/model opus' },
  fable: { name: 'Fable 5.1', use: '最难的推理和长时间自主任务', price: 10, command: '/model claude-fable-5-1' },
}

/** The tier a model id belongs to; null when it names none. */
export function tierOf(model: string): Tier | null {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus')) return 'opus'
  if (m.includes('fable') || m.includes('mythos')) return 'fable'
  return null
}

export type Project = { files: number; codeFiles: number }

export type Advice = {
  tier: Tier
  /** What in the prompt or the session led there, a few words each. */
  reasons: string[]
  /** One line on switching from the current model; '' when it already fits. */
  note: string
  /** True when the current model is the one advised. */
  fits: boolean
}

type Rule = { re: RegExp; weight: number; why: string }

// Weighted by how much thinking the ask needs; the first match of each counts.
const RULES: readonly Rule[] = [
  { re: /架构|重构|重新设计|系统设计|从零|整个项目|全部文件|跨模块|多个文件|迁移|升级到|architecture|refactor|redesign|migrat/i, weight: 3, why: '大范围改动' },
  { re: /并发|死锁|竞态|内存泄漏|性能瓶颈|性能优化|安全漏洞|根因|偶发|race condition|deadlock|memory leak|root cause|flaky/i, weight: 3, why: '难排查的问题' },
  { re: /算法|证明|推导|数学|优化方案|方案对比|权衡|algorithm|proof|trade-?off/i, weight: 2, why: '需要推理' },
  { re: /为什么|原因|排查|调试|报错|异常|崩溃|不工作|失败|debug|error|exception|crash|traceback|stack trace/i, weight: 2, why: '排查错误' },
  { re: /实现|开发|写一个|新增|添加功能|加个功能|接口|模块|组件|脚本|测试用例|单元测试|implement|build|feature|endpoint|unit test/i, weight: 1, why: '写代码' },
  { re: /修复|修改|改一下|bug|fix|patch/i, weight: 1, why: '改代码' },
  { re: /解释|是什么|什么意思|翻译|总结|概括|改名|重命名|拼写|错别字|格式化|加注释|查一下|列出|怎么用|explain|what is|translate|summari[sz]e|rename|typo|format/i, weight: -2, why: '简单问答' },
]

const STACK_TRACE = /(^|\n)\s*(at\s+\S+\s*\(|File ".+", line \d+|Traceback|\w+(Error|Exception):)/

/** Scores the draft; higher needs a stronger model. */
export function score(text: string, project: Project | null): { points: number; reasons: string[] } {
  const reasons: string[] = []
  let points = 0
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      points += rule.weight
      reasons.push(rule.why)
    }
  }
  if (STACK_TRACE.test(text) && !reasons.includes('排查错误')) {
    points += 2
    reasons.push('附了报错栈')
  }
  if (/```/.test(text)) {
    points += 1
    reasons.push('附了代码')
  }
  const mentions = text.match(/@\S+/g)?.length ?? 0
  if (mentions >= 3) {
    points += 1
    reasons.push(`提到 ${mentions} 个文件`)
  }
  const length = text.trim().length
  if (length > 2000) {
    points += 2
    reasons.push('需求很长')
  } else if (length > 600) {
    points += 1
    reasons.push('需求较长')
  } else if (length < 25 && points <= 0) {
    points -= 1
    reasons.push('一句话的小问题')
  }
  // A big codebase makes any code change harder to get right.
  if (project && project.codeFiles > 1500 && points >= 1) {
    points += 1
    reasons.push(`项目较大（${project.codeFiles} 个代码文件）`)
  }
  return { points, reasons }
}

export function tierFor(points: number): Tier {
  if (points <= -1) return 'haiku'
  if (points <= 2) return 'sonnet'
  if (points <= 9) return 'opus'
  // Fable costs 2.5 times Opus: only for asks that pile up every hard signal.
  return 'fable'
}

/**
 * The advice for a draft: a tier from the score, one step cheaper when the
 * 5-hour limit is nearly spent, and a note on switching from `current`.
 */
export function advise(a: {
  text: string
  project: Project | null
  current: string
  fivePct: number | null
  ctxTokens: number | null
}): Advice | null {
  if (a.text.trim().length < 4) return null
  const { points, reasons } = score(a.text, a.project)
  let tier = tierFor(points)
  if (a.fivePct !== null && a.fivePct >= 80 && tier !== 'haiku') {
    tier = TIERS[TIERS.indexOf(tier) - 1]!
    reasons.unshift(`5 小时限额已用 ${Math.round(a.fivePct)}%`)
  }
  if (reasons.length === 0) reasons.push('一般问题')

  const now = tierOf(a.current)
  const fits = now === tier
  let note = ''
  if (now && !fits) {
    const ratio = TIER_INFO[tier].price / TIER_INFO[now].price
    note =
      ratio < 1
        ? `比当前 ${TIER_INFO[now].name} 约省 ${Math.round((1 - ratio) * 100)}% 限额`
        : `当前 ${TIER_INFO[now].name} 可能不够，约多用 ${ratio.toFixed(ratio < 3 ? 1 : 0)} 倍限额`
    // Caches belong to one model: a switch re-reads the whole conversation.
    if (a.ctxTokens !== null && a.ctxTokens > 50_000) note += `；对话已有 ${Math.round(a.ctxTokens / 1000)}k，换模型会让缓存失效`
  }
  return { tier, reasons: reasons.slice(0, 3), note, fits }
}

export type Mix = { n: number; counts: [Tier, number][]; top: Tier }

/**
 * What the last prompts asked in one project needed, most advised first:
 * the model to default to there. Null under three advised prompts.
 */
export function projectMix(turns: readonly { proj: string; adv?: string; t0: number }[], proj: string, last = 20): Mix | null {
  const advised = turns.filter(t => t.proj === proj && t.adv && tierOf(t.adv) !== null).sort((a, b) => b.t0 - a.t0).slice(0, last)
  if (advised.length < 3) return null
  const counts = new Map<Tier, number>()
  for (const t of advised) counts.set(t.adv as Tier, (counts.get(t.adv as Tier) ?? 0) + 1)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || TIERS.indexOf(b[0]) - TIERS.indexOf(a[0]))
  return { n: advised.length, counts: sorted, top: sorted[0]![0] }
}

export function mixText(mix: Mix): string {
  return `本项目近 ${mix.n} 条：${mix.counts.map(([tier, n]) => `${TIER_INFO[tier].name.split(' ')[0]} ${n}`).join('、')}`
}
