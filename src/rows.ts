import type { Database } from 'bun:sqlite'
import { ADULT, BOOK, CHARACTER, type KeyTable, MAIN, present } from './client/format.ts'
import { compare } from './client/order.ts'
import { isBook, priorOf, weightOf } from './match.ts'
import type { Layer, NameKind } from './model.ts'

export type Dbs = Map<Layer, Database>

export const IDS =
  'SELECT entity AS id FROM names UNION SELECT id FROM entities UNION SELECT entity FROM refs UNION SELECT entity FROM homes'

export interface Scores {
  rank: Int32Array
  standing: Int32Array
  extra: Int8Array
  adult: Uint8Array
  book: Uint8Array
  related: Map<Layer, Map<number, number[]>>
}

export interface Context {
  eid: Map<string, number>
  ids: string[]
  masks: Uint8Array
  score: Scores
  kin: Map<number, number[]>
}

function numbering(dbs: Dbs): Pick<Context, 'eid' | 'ids' | 'masks'> {
  const seen = new Map<string, number>()
  for (const [layer, db] of dbs) {
    for (const { id } of db.query<{ id: string }, []>(IDS).iterate()) {
      if (!id.startsWith('w/') && !id.startsWith('c/')) throw new Error(`aninames: entity ${id} is neither w/ nor c/`)
      seen.set(id, (seen.get(id) ?? 0) | present(layer))
    }
  }
  const ids = [...seen.keys()].sort(compare)
  const masks = new Uint8Array(ids.length)
  ids.forEach((id, at) => {
    masks[at] = seen.get(id) ?? 0
  })
  return { eid: new Map(ids.map((id, at) => [id, at])), ids, masks }
}

export function reachOf(links: Map<number, Iterable<number>>, at: number): number[] {
  const found: number[] = []
  const seen = new Set([at])
  let frontier = [at]
  for (let hop = 1; hop <= 2; hop++) {
    const next: number[] = []
    for (const from of frontier) {
      for (const other of links.get(from) ?? []) {
        if (seen.has(other)) continue
        seen.add(other)
        next.push(other)
        found.push(other)
      }
    }
    frontier = next
  }
  return found
}

function scores(dbs: Dbs, eid: Map<string, number>): { score: Scores; links: Map<number, Set<number>> } {
  const n = eid.size
  const best = new Float64Array(n)
  const heads = new Map<number, [medium: string | null, type: string | null]>()
  const tagged = new Uint8Array(n)
  const adult = new Uint8Array(n)
  const spaces = new Uint32Array(n)
  const bits = new Map<string, number>()
  const links = new Map<number, Set<number>>()
  const related = new Map<Layer, Map<number, number[]>>()
  for (const [layer, db] of dbs) {
    for (const row of db.query<{ entity: string; rank: number }, []>('SELECT entity, rank FROM ranks').iterate()) {
      const at = eid.get(row.entity)
      if (at !== undefined) best[at] = Math.max(best[at] ?? 0, row.rank)
    }
    for (const row of db
      .query<{ id: string; kind: string; medium: string | null; type: string | null }, []>(
        'SELECT id, kind, medium, type FROM entities',
      )
      .iterate()) {
      const at = eid.get(row.id)
      if (at === undefined || row.kind !== 'work' || heads.has(at)) continue
      heads.set(at, [row.medium, row.type])
    }
    for (const row of db
      .query<{ entity: string }, []>("SELECT DISTINCT entity FROM refs WHERE ref GLOB 'danbooru:*'")
      .iterate()) {
      const at = eid.get(row.entity)
      if (at !== undefined) tagged[at] = 1
    }
    for (const row of db.query<{ entity: string }, []>('SELECT entity FROM adults').iterate()) {
      const at = eid.get(row.entity)
      if (at !== undefined) adult[at] = 1
    }
    for (const row of db
      .query<{ entity: string; space: string }, []>(
        "SELECT DISTINCT entity, substr(ref, 1, instr(ref, ':') - 1) AS space FROM refs",
      )
      .iterate()) {
      const at = eid.get(row.entity)
      if (at === undefined) continue
      let bit = bits.get(row.space)
      if (bit === undefined) {
        bit = bits.size
        if (bit >= 32) throw new Error('aninames: more than 32 ref namespaces')
        bits.set(row.space, bit)
      }
      spaces[at] = (spaces[at] ?? 0) | (1 << bit)
    }
    const own = new Map<number, number[]>()
    for (const row of db.query<{ work: string; other: string }, []>('SELECT work, other FROM related').iterate()) {
      const from = eid.get(row.work)
      const to = eid.get(row.other)
      if (from === undefined || to === undefined) continue
      const list = own.get(from)
      if (list) list.push(to)
      else own.set(from, [to])
      links.set(from, (links.get(from) ?? new Set()).add(to))
    }
    related.set(layer, own)
  }
  const rankOf = (at: number) => best[at] ?? 0
  const score: Scores = {
    rank: new Int32Array(n),
    standing: new Int32Array(n),
    extra: new Int8Array(n),
    adult,
    book: new Uint8Array(n),
    related,
  }
  for (const [id, at] of eid) {
    const rank = rankOf(at)
    let standing = rank
    const work = id.startsWith('w/')
    if (work) {
      let family = 0
      for (const other of reachOf(links, at)) family = Math.max(family, rankOf(other))
      standing = Math.max(standing, 0.9 * family)
    }
    let count = 0
    for (let mask = spaces[at] ?? 0; mask; mask &= mask - 1) count++
    score.rank[at] = Math.round(rank * 1000)
    score.standing[at] = Math.round(standing * 1000)
    const [medium = null, type = null] = heads.get(at) ?? []
    score.extra[at] = work ? priorOf(medium, type, tagged[at] === 1) : Math.min(10, 2 * Math.max(0, count - 1))
    if (isBook(medium)) score.book[at] = 1
  }
  return { score, links }
}

function kinOf(dbs: Dbs, context: Omit<Context, 'kin'>, links: Map<number, Set<number>>): Map<number, number[]> {
  const { eid, ids } = context
  const head = Int32Array.from(ids, (_, at) => at)
  const find = (start: number): number => {
    let at = start
    while (head[at] !== at) {
      head[at] = head[head[at] as number] as number
      at = head[at] as number
    }
    return at
  }
  for (const [from, others] of links) {
    for (const to of others) {
      const [a, b] = [find(from), find(to)]
      if (a !== b) head[Math.max(a, b)] = Math.min(a, b)
    }
  }
  const kin = new Map<number, number[]>()
  ids.forEach((id, at) => {
    if (id.startsWith('w/') && find(at) !== at) kin.set(at, [find(at)])
  })
  const casts = new Map<number, Set<number>>()
  for (const db of dbs.values()) {
    for (const row of db
      .query<{ character: string; work: string }, []>('SELECT character, work FROM works')
      .iterate()) {
      const who = eid.get(row.character)
      const work = eid.get(row.work)
      if (who === undefined || work === undefined) continue
      casts.set(who, (casts.get(who) ?? new Set<number>()).add(find(work)))
    }
  }
  for (const [who, families] of casts)
    kin.set(
      who,
      [...families].sort((a, b) => a - b),
    )
  return kin
}

export function contextOf(dbs: Dbs): Context {
  const numbered = numbering(dbs)
  const { score, links } = scores(dbs, numbered.eid)
  const context = { ...numbered, score }
  return { ...context, kin: kinOf(dbs, context, links) }
}

export interface KeySource {
  key: string
  entity: string
  ekind: string
  kind: NameKind
  variant: number
  support: number
}

export type Sorted = Exclude<KeyTable, 'tail'>

export type Key = [
  key: string,
  eid: number,
  weight: number,
  flags: number,
  rank: number,
  standing: number,
  extra: number,
  kin?: number | number[],
]

export interface Span {
  low: string
  high: string
  open?: boolean
  limit?: number
}

const NAME_COLUMNS = 'n.entity AS entity, n.ekind AS ekind, n.kind AS kind, n.variant AS variant, n.support AS support'

const KEYED: Record<Sorted, [column: string, from: string, where?: string]> = {
  flat: ['n.flat', 'names n'],
  latin: ['n.latin', 'names n', "n.latin GLOB '*[a-z]*'"],
  sound: ['s.key', 'sounds s JOIN names n ON n.rowid = s.name'],
  part: ['p.part', 'parts p JOIN names n ON n.rowid = p.name'],
  initial: ['i.key', 'initials i JOIN names n ON n.rowid = i.name'],
}

function sql(table: Sorted, span?: Span): string {
  const [column, from, where] = KEYED[table]
  const head = `SELECT ${column} AS key, ${NAME_COLUMNS}, n.rowid AS rowid FROM ${from}`
  if (!span) return `${head}${where ? ` WHERE ${where}` : ''} ORDER BY key, entity, n.rowid`
  const within = span.open ? `${column} > ?1 AND ${column} < ?2` : `${column} >= ?1 AND ${column} <= ?2`
  return `${head} WHERE ${where ? `${where} AND ` : ''}${within} ORDER BY ${column} LIMIT ?3`
}

export function* keysOf(rows: Iterable<KeySource>, context: Context): Generator<Key> {
  const { eid, masks, score, kin } = context
  let group: { key: string; at: number; character: boolean; best: [number, boolean]; main: number } | undefined
  function* emit(): Generator<Key> {
    if (!group) return
    const { key, at, character, best, main } = group
    const flags =
      (character ? CHARACTER : 0) | (score.adult[at] ? ADULT : 0) | (score.book[at] ? BOOK : 0) | (masks[at] ?? 0)
    const scores = [score.rank[at] ?? 0, score.standing[at] ?? 0, score.extra[at] ?? 0] as const
    const family = kin.get(at)
    const more: [number | number[]] | [] = family ? [family.length === 1 ? (family[0] as number) : family] : []
    yield [key, at, best[0], flags | (best[1] ? MAIN : 0), ...scores, ...more]
    if (!best[1] && main >= 0) yield [key, at, main, flags | MAIN, ...scores, ...more]
  }
  for (const row of rows) {
    const at = eid.get(row.entity)
    if (at === undefined) continue
    const weight = Math.round(weightOf(row) * 1000)
    const isMain = row.kind === 'main' || row.kind === 'official'
    if (!group || group.key !== row.key || group.at !== at) {
      yield* emit()
      group = {
        key: row.key,
        at,
        character: row.ekind === 'character',
        best: [weight, isMain],
        main: isMain ? weight : -1,
      }
      continue
    }
    if (weight > group.best[0] || (weight === group.best[0] && isMain)) group.best = [weight, isMain]
    if (isMain && weight > group.main) group.main = weight
  }
  yield* emit()
}

export function* keyRows(db: Database, table: Sorted, context: Context, span?: Span): Generator<Key> {
  if (!span) {
    yield* keysOf(db.query<KeySource, []>(sql(table)).iterate(), context)
    return
  }
  const rows = db
    .query<KeySource & { rowid: number }, [string, string, number]>(sql(table, span))
    .all(span.low, span.high, span.limit ?? -1)
  rows.sort((a, b) => compare(a.key, b.key) || compare(a.entity, b.entity) || a.rowid - b.rowid)
  yield* keysOf(rows, context)
}
