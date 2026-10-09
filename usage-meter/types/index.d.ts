/**
 * One reading of the limits: when, the 5-hour %, the weekly %, the context %,
 * and when that 5-hour window resets (absent in readings from 0.1.0).
 */
export type UsageMeterSample = [t: number, five: number | null, seven: number | null, ctx: number | null, r5?: number | null]

/** The newest reading any session took, shared through the store. */
export type UsageMeterLast = { t: number; five?: UsageMeterLimit; seven?: UsageMeterLimit }

/** One rate-limit window as the last API response reported it. */
export type UsageMeterLimit = { kind: string; pct: number; resetsAt?: string }

/** Token counts: uncached input, cache write, cache read, output. */
export type UsageMeterTok = { i: number; cw: number; cr: number; o: number }

/**
 * One prompt of yours and everything it set off (its model requests, the
 * tools and subagents they ran), or a stretch of background work.
 */
export type UsageMeterTurn = {
  id: string
  /** First 8 characters of the session id. */
  sid: string
  t0: number
  t1: number
  /** The project folder's name. */
  proj: string
  /** The prompt's first characters. */
  text: string
  tok: UsageMeterTok
  /** Price-weighted cost by where it went (see `attribute`). */
  cats: Record<string, number>
  /** Price-weighted cost by model. */
  models: Record<string, number>
  /** The sum of `cats`. */
  w: number
  /** Dollars by the engine's own ledger, API prices; null when unknown. */
  usd: number | null
  /** Points of the 5-hour limit this turn moved. */
  p5: number
  /** Points of the weekly limit this turn moved. */
  p7: number
  steps: number
  tools: number
  agents: number
  /** The tier advised for the prompt, when one was. */
  adv?: string
}

/** The latest figures, as the status line has them. */
export type UsageMeterLive = {
  limits: UsageMeterLimit[]
  /** When `limits` was read; 0 before any reading. */
  limitsAt: number
  ctxTokens: number | null
  ctxWindow: number | null
  ctxPct: number | null
  /** This session's cost so far, API prices. */
  usd: number | null
}

/** One row of the /context breakdown. */
export type UsageMeterCtxCat = { name: string; tokens: number; kind: string }

/** The model advised for the prompt being typed. */
export type UsageMeterAdvice = {
  tier: string
  reasons: string[]
  note: string
  fits: boolean
  /** True for a prompt already sent (the desktop app shows no draft to plugins). */
  sent?: boolean
}

export type UsageMeterTab = 'now' | 'time' | 'where' | 'turns'
export type UsageMeterRange = '5h' | '24h' | '7d'
export type UsageMeterView = { tab: UsageMeterTab; range: UsageMeterRange }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      live: UsageMeterLive
      samples: UsageMeterSample[]
      /** The readings this session took, which it alone stores. */
      mine: UsageMeterSample[]
      turns: UsageMeterTurn[]
      current: UsageMeterTurn | null
      ctxCats: UsageMeterCtxCat[] | null
      advice: UsageMeterAdvice | null
      view: UsageMeterView
      now: number
    }
  }
}
