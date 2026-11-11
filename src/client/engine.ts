import { belowSeed, liftsBelow, swapLayout, TOP, typing } from '../match.ts'
import type { Kind } from '../model.ts'
import { editDistance, flat, latinKey, partKey, qualifiers, soundKeys } from '../text.ts'
import type { Reader } from './chunks.ts'
import { ADULT, BOOK, CHARACTER, type KeyRow, type KeyTable, layersOf, MAIN } from './format.ts'

export type Match = 'name' | 'part' | 'prefix' | 'sound' | 'typo' | 'family'

export function matchOf(how: string): Match {
  const inner = how.replace(/^layout\((.*)\)$/, '$1')
  if (inner.startsWith('family(')) return 'family'
  if (inner === 'part' || inner === 'sound' || inner === 'typo') return inner
  if (inner === 'prefix' || inner === 'typing' || inner === 'initials prefix') return 'prefix'
  if (inner === 'ending') return 'part'
  return 'name'
}

export interface Hit {
  eid: number
  kind: Kind
  score: number
  matched: string
  how: string
  rank: number
  standing: number
  extra: number
  adult: boolean
  mask: number
  book: boolean
  kin: readonly number[]
  tied: boolean
  seed?: number
}

const SEEDS = 8
const FAMILIES = 3
const WHOLE = 80
const ONE_OFF = 75
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const SPANS = 2

function hitOf(row: KeyRow, score: number, how: string): Hit {
  const flags = row[3]
  const character = (flags & CHARACTER) !== 0
  return {
    eid: row[1],
    kind: character ? 'character' : 'work',
    score,
    matched: row[0],
    how,
    rank: row[4],
    standing: row[5],
    extra: row[6],
    adult: (flags & ADULT) !== 0,
    mask: layersOf(flags),
    book: (flags & BOOK) !== 0,
    kin: row[8] ?? (character ? [] : [row[1]]),
    tied: !character && row[8] !== undefined,
  }
}

function keeper(kind?: Kind): ((row: KeyRow) => boolean) | undefined {
  if (!kind) return undefined
  const character = kind === 'character'
  return (row) => ((row[3] & CHARACTER) !== 0) === character
}

function candidates(view: Reader, query: string, kind?: Kind, whole = false): Map<number, Hit> {
  const hits = new Map<number, Hit>()
  const keep = keeper(kind)
  const consider = (row: KeyRow, base: number, how: string) => {
    if (keep && !keep(row)) return
    const score = base * (row[2] / 1000)
    const current = hits.get(row[1])
    if (!current || current.score < score) hits.set(row[1], hitOf(row, score, how))
  }
  const exact = (table: KeyTable, key: string) => view.keys(table, { low: key, high: key, ...(keep ? { keep } : {}) })
  const prefix = (table: KeyTable, low: string, high: string) =>
    view.keys(table, { low, high, open: true, limit: 3000, spans: SPANS, ...(keep ? { keep } : {}) })
  const q = flat(query)
  if (!q) return hits
  for (const row of exact('flat', q)) consider(row, 100, 'exact')
  const latin = latinKey(query)
  if (latin && /[a-z]/.test(latin)) for (const row of exact('latin', latin)) consider(row, 95, 'latin')
  if (/^[ㄱ-ㅎ\s]+$/.test(query.trim())) {
    const key = query.replace(/\s+/g, '')
    for (const row of exact('initial', key)) consider(row, 86, 'initials')
    for (const row of prefix('initial', key, `${key}${TOP}`))
      consider(row, 60 + 20 * ([...key].length / [...row[0]].length), 'initials prefix')
  }
  if (!/\s/.test(query.trim())) {
    for (const row of exact('part', partKey(query)))
      consider(row, row[3] & CHARACTER && row[3] & MAIN ? 92 : 84, 'part')
  }
  for (const key of /[ㄱ-ㅎㅏ-ㅣᄀ-ᇿ]/.test(query) ? [] : soundKeys(qualifiers(query).base)) {
    for (const row of exact('sound', key)) consider(row, 82, 'sound')
  }
  const length = [...q].length
  for (const [low, high] of typing(q)) {
    for (const row of prefix('flat', low, high))
      consider(row, 60 + 25 * (length / [...row[0]].length), low === q ? 'prefix' : 'typing')
  }
  if (whole && length >= 3 && UNSPACED.test(q)) {
    for (const row of view.ending(q, kind)) consider(row, 40 + 30 * (length / [...row[0]].length), 'ending')
  }
  return hits
}

function fuzzy(view: Reader, query: string, kind?: Kind): Map<number, Hit> {
  const hits = new Map<number, Hit>()
  const q = flat(query)
  const chars = [...q]
  if (chars.length < 4) return hits
  const limit = chars.length >= 8 ? 2 : 1
  const keep = keeper(kind)
  for (const row of view.near(q, kind)) {
    if (keep && !keep(row)) continue
    const name = [...row[0]]
    let score = 0
    const whole = editDistance(q, row[0], limit)
    if (whole <= limit) score = 92 - 10 * whole
    else if (name.length > chars.length) {
      const lead = editDistance(q, name.slice(0, chars.length).join(''), limit)
      if (lead <= limit) score = 72 - 10 * lead
    }
    if (score === 0) continue
    score *= row[2] / 1000
    const current = hits.get(row[1])
    if (!current || current.score < score) hits.set(row[1], hitOf(row, score, 'typo'))
  }
  return hits
}

function family(view: Reader, hits: Map<number, Hit>, query: string): void {
  const wanted = flat(query)
  const works = [...hits.values()].filter((hit) => hit.kind === 'work')
  const seeds = works
    .filter((hit) => hit.score >= 50)
    .sort((a, b) => b.score - a.score || Number(a.book) - Number(b.book) || a.eid - b.eid)
    .slice(0, SEEDS)
  const read = new Map<number, KeyRow[]>()
  for (const seed of seeds) {
    const score = seed.score * 0.97
    const lifted = (own: Hit | undefined) => ({
      score,
      matched: seed.matched,
      how: `family(${seed.how})`,
      ...(liftsBelow(seed.how, seed.book, own?.how) ? { seed: seed.eid } : {}),
    })
    for (const { eid } of works) {
      const own = hits.get(eid) as Hit
      if (eid === seed.eid || own.kin[0] !== seed.kin[0] || own.score >= score) continue
      if (own.how !== 'part' && !own.matched.includes(wanted) && !own.matched.includes(seed.matched)) continue
      hits.set(eid, { ...own, ...lifted(own) })
    }
    const family = seed.kin[0] as number
    if (!seed.tied || (!read.has(family) && read.size >= FAMILIES)) continue
    const rows = read.get(family) ?? view.kin(family)
    read.set(family, rows)
    for (const row of rows) {
      const own = hits.get(row[1])
      if (row[1] === seed.eid || (own && own.score >= score)) continue
      if (!row[0].includes(wanted) && !row[0].includes(seed.matched)) continue
      hits.set(row[1], { ...hitOf(row, score, ''), kin: seed.kin, tied: true, ...lifted(own) })
    }
  }
}

function scoped(view: Reader, query: string): Map<number, Hit> {
  const hits = new Map<number, Hit>()
  const tokens = query.normalize('NFKC').split(/\s+/).filter(Boolean)
  for (let cut = 1; cut < tokens.length; cut++) {
    for (const [who, where] of [
      [tokens.slice(0, cut), tokens.slice(cut)],
      [tokens.slice(cut), tokens.slice(0, cut)],
    ] as const) {
      const people = [...candidates(view, who.join(' '), 'character').values()].filter((h) => h.score >= 80)
      const families = new Map<number, number>()
      for (const work of candidates(view, where.join(' '), 'work').values()) {
        const family = work.kin[0] as number
        if (work.score >= 50) families.set(family, Math.max(families.get(family) ?? 0, work.score))
      }
      for (const person of people) {
        const titled = Math.max(0, ...person.kin.map((each) => families.get(each) ?? 0))
        if (titled === 0) continue
        const score = 90 + person.score / 10
        const how = titled >= WHOLE ? 'scoped-work' : 'scoped-start'
        const current = hits.get(person.eid)
        if (!current || current.score < score) hits.set(person.eid, { ...person, score, how })
      }
    }
  }
  return hits
}

export interface Options {
  kind?: Kind
  limit?: number
  adult?: boolean
}

export function search(view: Reader, query: string, options: Options = {}): Hit[] | undefined {
  const { kind } = options
  const hits = candidates(view, query, kind, true)
  const swapped = swapLayout(query)
  const other = swapped ? candidates(view, swapped, kind) : undefined
  const people = !kind || kind === 'character' ? scoped(view, query) : undefined
  if (view.wanted.size > 0) return undefined
  const typed = [...hits.values()].sort((a, b) => b.score - a.score)[0]
  for (const [eid, hit] of people ?? []) {
    const current = hits.get(eid)
    if (current && current.score >= Math.min(hit.score, typed && typed.score >= WHOLE ? WHOLE : hit.score)) continue
    hits.set(eid, typed && typed.score >= WHOLE ? { ...hit, seed: typed.eid } : hit)
  }
  if (!kind || kind === 'work') family(view, hits, query)
  const firm = () => Math.max(0, ...[...hits.values()].map((h) => (h.how === 'scoped-start' ? 0 : h.score)))
  const typos = !typed && !other?.size && firm() < 95 ? fuzzy(view, query, kind) : undefined
  if (typos && view.wanted.size > 0) return undefined
  const merge = (more: Map<number, Hit>, factor: number, how?: string) => {
    for (const [eid, hit] of more) {
      const score = hit.score * factor
      const current = hits.get(eid)
      if (!current || current.score < score) hits.set(eid, { ...hit, score, how: how ? `${how}(${hit.how})` : hit.how })
    }
  }
  if (firm() < 90 && other) merge(other, 0.95, 'layout')
  if (typos && firm() < 95) {
    const mended = [...typos.values()].sort((a, b) => b.score - a.score)[0]
    if (mended && mended.score >= ONE_OFF) {
      for (const [eid, hit] of hits) if (hit.how === 'scoped-start') hits.set(eid, { ...hit, seed: mended.eid })
    }
    merge(typos, 1)
  }
  const prior = (hit: Hit) => (hit.kind === 'work' ? hit.extra : 0)
  const first = [...hits.values()]
    .map((hit) => ({ ...hit, score: hit.score + (15 * hit.rank) / 1000 + prior(hit) }))
    .sort((a, b) => b.score - a.score)
    .filter((hit) => options.adult !== false || !hit.adult)
    .slice(0, 60)
  const weight = /\s/.test(query.trim()) ? 15 : 25
  const scored = first.map((hit) => ({
    ...hit,
    score: (hits.get(hit.eid)?.score ?? 0) + (weight * hit.standing) / 1000 + hit.extra,
  }))
  const finals = new Map(scored.map((hit) => [hit.eid, hit.score]))
  return scored
    .map((hit) => ({ ...hit, score: belowSeed(hit.score, hit.seed === undefined ? undefined : finals.get(hit.seed)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 10)
}
