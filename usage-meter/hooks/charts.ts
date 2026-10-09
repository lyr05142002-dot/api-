import type { UsageMeterSample as Sample } from '../types'
import { fmtDayClock, fmtPct } from './model'

// Drawn as an image, so the colours sit in the markup: light steps by
// default, dark steps when the viewer's system is dark.
const STYLE =
  '<style>' +
  '.tk{fill:#e6e5e0}.gd{stroke:#e6e5e0}.tx{fill:#6b6a65;font:10px system-ui,sans-serif}' +
  '.s1{fill:#2a78d6}.l1{stroke:#2a78d6}.s2{fill:#eb6834}.l2{stroke:#eb6834}' +
  '.warn{fill:#fab219}.crit{fill:#d03b3b}.hit{fill:transparent}.hit:hover{fill:rgba(128,128,128,.12)}' +
  '@media (prefers-color-scheme:dark){.tk{fill:#2e2e2b}.gd{stroke:#383835}.tx{fill:#a9a89f}' +
  '.s1{fill:#3987e5}.l1{stroke:#3987e5}.s2{fill:#d95926}.l2{stroke:#d95926}}' +
  '</style>'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const r1 = (n: number) => Math.round(n * 10) / 10

function svg(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${STYLE}${body}</svg>`
}

/** Fill class for a limit meter: blue, then the status colours near the cap. */
function meterClass(pct: number, isLimit: boolean): string {
  if (!isLimit) return 's1'
  if (pct >= 95) return 'crit'
  if (pct >= 80) return 'warn'
  return 's1'
}

/** A progress bar like the app's own usage popover. */
export function meterSvg(pct: number, isLimit = true, width = 300): string {
  const p = Math.max(0, Math.min(100, pct))
  const fill = p > 0 ? Math.max(4, (width * p) / 100) : 0
  return svg(
    width,
    8,
    `<rect class="tk" x="0" y="0" width="${width}" height="8" rx="4"/>` +
      (fill > 0 ? `<rect class="${meterClass(p, isLimit)}" x="0" y="0" width="${r1(fill)}" height="8" rx="4"/>` : ''),
  )
}

/** The same bar in text, for the terminal. */
export function meterText(pct: number, cells = 24): string {
  const p = Math.max(0, Math.min(100, pct))
  const full = Math.round((cells * p) / 100)
  return '█'.repeat(full) + '░'.repeat(cells - full)
}

const SPARK = '▁▂▃▄▅▆▇█'

export function sparkText(values: readonly (number | null)[], max: number): string {
  return values
    .map(v => (v === null ? ' ' : SPARK[Math.min(7, Math.max(0, Math.round((v / Math.max(max, 1e-9)) * 7)))]))
    .join('')
}

/** The last reading at or before each bucket's end; null before the first. */
export function levels(samples: readonly Sample[], idx: 1 | 2, from: number, to: number, n: number): (number | null)[] {
  const out: (number | null)[] = []
  const size = (to - from) / n
  let j = 0
  let cur: number | null = null
  for (let k = 0; k < n; k++) {
    const end = from + (k + 1) * size
    while (j < samples.length && samples[j]![0] <= end) {
      const v = samples[j]![idx]
      if (v !== null) cur = v
      j++
    }
    out.push(cur)
  }
  return out
}

const X0 = 30
const X1 = 314
const W = 320

/** Step line of a series' readings, held to `to`. */
function stepPath(samples: readonly Sample[], idx: 1 | 2, from: number, to: number, y: (v: number) => number): string {
  const x = (t: number) => r1(X0 + ((t - from) / (to - from)) * (X1 - X0))
  let d = ''
  let last: number | null = null
  // The reading in force when the range opens.
  for (const s of samples) {
    if (s[0] >= from) break
    if (s[idx] !== null) last = s[idx]
  }
  if (last !== null) d += `M${X0},${r1(y(last))}`
  for (const s of samples) {
    const v = s[idx]
    if (s[0] < from || s[0] > to || v === null) continue
    d += d === '' ? `M${x(s[0])},${r1(y(v))}` : `H${x(s[0])}V${r1(y(v))}`
    last = v
  }
  if (d !== '' && last !== null) d += `H${X1}`
  return d
}

/** The 5-hour and weekly limits over the range, one axis (0–100%). */
export function limitsChartSvg(samples: readonly Sample[], from: number, to: number, now: number): string {
  const top = 8
  const bottom = 104
  const y = (v: number) => bottom - (Math.min(100, Math.max(0, v)) / 100) * (bottom - top)
  let body = ''
  for (const v of [0, 50, 100]) {
    body += `<line class="gd" x1="${X0}" x2="${X1}" y1="${y(v)}" y2="${y(v)}" stroke-width="1"/>`
    body += `<text class="tx" x="${X0 - 4}" y="${y(v) + 3}" text-anchor="end">${v}%</text>`
  }
  for (const [i, anchor, t] of [
    [0, 'start', from],
    [1, 'middle', (from + to) / 2],
    [2, 'end', to],
  ] as const) {
    const xx = i === 0 ? X0 : i === 1 ? (X0 + X1) / 2 : X1
    body += `<text class="tx" x="${xx}" y="${bottom + 13}" text-anchor="${anchor}">${esc(fmtDayClock(t, now))}</text>`
  }
  const p2 = stepPath(samples, 2, from, to, y)
  const p1 = stepPath(samples, 1, from, to, y)
  if (p2) body += `<path class="l2" d="${p2}" fill="none" stroke-width="2" stroke-linejoin="round"/>`
  if (p1) body += `<path class="l1" d="${p1}" fill="none" stroke-width="2" stroke-linejoin="round"/>`

  // Hover targets: one column per bucket, its reading as a tooltip.
  const n = 48
  const five = levels(samples, 1, from, to, n)
  const seven = levels(samples, 2, from, to, n)
  const bw = (X1 - X0) / n
  for (let k = 0; k < n; k++) {
    const end = from + ((k + 1) * (to - from)) / n
    if (five[k] === null && seven[k] === null) continue
    const tip = `${fmtDayClock(end, now)}  5小时 ${five[k] === null ? '—' : fmtPct(five[k]!)} · 每周 ${seven[k] === null ? '—' : fmtPct(seven[k]!)}`
    body += `<rect class="hit" x="${r1(X0 + k * bw)}" y="${top}" width="${r1(bw)}" height="${bottom - top}"><title>${esc(tip)}</title></rect>`
  }
  return svg(W, bottom + 18, body)
}

/** Points of the 5-hour limit spent per bucket, with a tooltip each. */
export function burnChartSvg(buckets: readonly number[], from: number, to: number, now: number, tips: readonly string[]): string {
  const top = 14
  const bottom = 64
  const max = Math.max(1, ...buckets)
  const n = buckets.length
  const bw = (X1 - X0) / n
  let body = `<line class="gd" x1="${X0}" x2="${X1}" y1="${bottom}" y2="${bottom}" stroke-width="1"/>`
  body += `<text class="tx" x="${X0 - 4}" y="${top + 3}" text-anchor="end">${esc(fmtPct(max))}</text>`
  body += `<text class="tx" x="${X0 - 4}" y="${bottom + 3}" text-anchor="end">0</text>`
  for (let k = 0; k < n; k++) {
    const v = buckets[k]!
    const h = (v / max) * (bottom - top)
    const x = X0 + k * bw + 1
    const start = from + (k * (to - from)) / n
    const end = start + (to - from) / n
    const tip = `${fmtDayClock(start, now)}–${fmtDayClock(end, now)}  +${fmtPct(v)}${tips[k] ? '\n' + tips[k] : ''}`
    if (h > 0) {
      body += `<rect class="s1" x="${r1(x)}" y="${r1(bottom - Math.max(h, 1.5))}" width="${r1(Math.max(1, bw - 2))}" height="${r1(Math.max(h, 1.5))}" rx="1"/>`
    }
    body += `<rect class="hit" x="${r1(X0 + k * bw)}" y="${top - 6}" width="${r1(bw)}" height="${bottom - top + 6}"><title>${esc(tip)}</title></rect>`
  }
  body += `<text class="tx" x="${X0}" y="${bottom + 13}">${esc(fmtDayClock(from, now))}</text>`
  body += `<text class="tx" x="${X1}" y="${bottom + 13}" text-anchor="end">${esc(fmtDayClock(to, now))}</text>`
  return svg(W, bottom + 18, body)
}
