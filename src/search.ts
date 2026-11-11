import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Range, Reader } from './client/chunks.ts'
import { search as rank } from './client/engine.ts'
import { type KeyRow, type KeyTable, readRows } from './client/format.ts'
import { compare } from './client/order.ts'
import { type Kind, LAYERS, type Layer, type NameKind, SPINE } from './model.ts'
import { type Context, contextOf, type Key, type KeySource, keyRows, keysOf } from './rows.ts'
import { flat } from './text.ts'

export interface Hit {
  id: string
  kind: Kind
  score: number
  matched: string
  how: string
  adult: boolean
}

export interface Card {
  id: string
  kind: Kind
  medium: string | null
  names: { text: string; lang: string | null; kind: NameKind; source: string }[]
  refs: string[]
  works: string[]
}

const SPAN_ROWS = 750

const MOST_NEAR = 3000

const NEAR = `SELECT n.flat AS key, n.entity AS entity, n.ekind AS ekind, n.kind AS kind, n.variant AS variant,
  n.support AS support, n.rowid AS rowid
FROM names_fts f JOIN names n ON n.rowid = f.rowid WHERE names_fts MATCH ?1`

export class Index implements Reader {
  readonly layers: Layer[]
  readonly wanted: ReadonlySet<string> = new Set()
  private readonly dbs = new Map<Layer, Database>()
  private readonly context: Context
  private readonly ranks = new Map<string, number>()

  constructor(dir: string, layers: Layer[] = [...LAYERS]) {
    for (const layer of [SPINE, ...layers.filter((each) => each !== SPINE)]) {
      const path = join(dir, `${layer}.sqlite`)
      if (existsSync(path)) this.dbs.set(layer, new Database(path, { readonly: true }))
      else if (layer === SPINE) throw new Error(`aninames: ${path} is missing; run mise run build`)
    }
    this.layers = [...this.dbs.keys()]
    this.context = contextOf(this.dbs)
  }

  close(): void {
    for (const db of this.dbs.values()) db.close()
  }

  private union<T>(sql: string, ...params: (string | number)[]): T[] {
    const rows: T[] = []
    for (const db of this.dbs.values()) rows.push(...(db.query(sql).all(...params) as T[]))
    return rows
  }

  private read(rows: Iterable<Key>): KeyRow[] {
    return (readRows('flat', [...rows]) ?? []) as KeyRow[]
  }

  keys(table: KeyTable, range: Range): KeyRow[] {
    if (table === 'tail') return []
    const { low, high, open = false, limit = Number.POSITIVE_INFINITY, spans, keep } = range
    const span = { low, high, open, ...(spans === undefined ? {} : { limit: spans * SPAN_ROWS }) }
    const out: KeyRow[] = []
    for (const db of this.dbs.values()) {
      let taken = 0
      for (const row of this.read(keyRows(db, table, this.context, span))) {
        if (taken >= limit) break
        if (keep && !keep(row)) continue
        out.push(row)
        taken++
      }
    }
    return out
  }

  near(name: string, kind?: Kind): KeyRow[] {
    const chars = [...name]
    const grams: string[] = []
    for (let i = 0; i + 3 <= chars.length; i++)
      grams.push(
        `"${chars
          .slice(i, i + 3)
          .join('')
          .replaceAll('"', '""')}"`,
      )
    if (grams.length === 0) return []
    const probes =
      grams.length <= 5
        ? [grams.join(' OR ')]
        : [...new Set([`${grams[0]} AND ${grams[1]}`, `${grams.at(-2)} AND ${grams.at(-1)}`])]
    const sql = `${NEAR}${kind ? ' AND n.ekind = ?2' : ''} ORDER BY f.rank LIMIT ${MOST_NEAR}`
    const out: KeyRow[] = []
    for (const db of this.dbs.values()) {
      const found = new Map<number, KeySource & { rowid: number }>()
      for (const probe of probes) {
        const rows = db.query<KeySource & { rowid: number }, string[]>(sql).all(...(kind ? [probe, kind] : [probe]))
        for (const row of rows) found.set(row.rowid, row)
      }
      const sorted = [...found.values()].sort(
        (a, b) => compare(a.key, b.key) || compare(a.entity, b.entity) || a.rowid - b.rowid,
      )
      out.push(...this.read(keysOf(sorted, this.context)))
    }
    return out
  }

  ending(name: string, kind?: Kind): KeyRow[] {
    const sql = `${NEAR}${kind ? ' AND n.ekind = ?2' : ''} LIMIT ${MOST_NEAR}`
    const phrase = `"${name.replaceAll('"', '""')}"`
    const out: KeyRow[] = []
    for (const db of this.dbs.values()) {
      const rows = db
        .query<KeySource & { rowid: number }, string[]>(sql)
        .all(...(kind ? [phrase, kind] : [phrase]))
        .filter((row) => row.key !== name && row.key.endsWith(name))
      rows.sort((a, b) => compare(a.key, b.key) || compare(a.entity, b.entity) || a.rowid - b.rowid)
      out.push(...this.read(keysOf(rows, this.context)))
    }
    return out
  }

  search(query: string, options: { kind?: Kind; limit?: number; adult?: boolean } = {}): Hit[] {
    return (rank(this, query, options) ?? []).map((hit) => ({
      id: this.context.ids[hit.eid] as string,
      kind: hit.kind,
      score: hit.score,
      matched: hit.matched,
      how: hit.how,
      adult: hit.adult,
    }))
  }

  rank(id: string): number {
    const cached = this.ranks.get(id)
    if (cached !== undefined) return cached
    const rows = this.union<{ rank: number }>('SELECT rank FROM ranks WHERE entity = ?', id)
    const best = Math.max(0, ...rows.map((row) => row.rank))
    this.ranks.set(id, best)
    return best
  }

  copyrights(id: string): string[] {
    return this.union<{ tag: string }>('SELECT tag FROM copyrights WHERE entity = ?', id).map((row) => row.tag)
  }

  home(id: string): string | undefined {
    return this.union<{ tag: string }>('SELECT tag FROM homes WHERE entity = ?', id).at(-1)?.tag
  }

  refs(id: string): string[] {
    return this.union<{ ref: string }>('SELECT ref FROM refs WHERE entity = ?', id).map((r) => r.ref)
  }

  resolve(ref: string, kind?: Kind): string | undefined {
    const prefix = kind === 'work' ? 'w/%' : kind === 'character' ? 'c/%' : '%'
    return this.union<{ entity: string }>(
      'SELECT entity FROM refs WHERE ref = ? AND entity LIKE ? LIMIT 1',
      ref,
      prefix,
    )[0]?.entity
  }

  card(id: string): Card | undefined {
    const head = this.union<{ kind: Kind; medium: string | null }>(
      'SELECT kind, medium FROM entities WHERE id = ?',
      id,
    )[0]
    if (!head) return undefined
    const { kind, medium } = head
    const names = this.union<Card['names'][number]>('SELECT text, lang, kind, source FROM names WHERE entity = ?', id)
    const works = [
      ...new Set(this.union<{ work: string }>('SELECT work FROM works WHERE character = ?', id).map((r) => r.work)),
    ]
    return { id, kind, medium, names, refs: this.refs(id), works }
  }

  private preferred(id: string, lang: string): { text: string; kind: NameKind } | undefined {
    return this.union<{ text: string; kind: NameKind; pref: number }>(
      'SELECT text, kind, pref FROM names WHERE entity = ? AND lang = ? AND pref IS NOT NULL',
      id,
      lang,
    ).sort((a, b) => a.pref - b.pref)[0]
  }

  label(id: string, langs: string[] = ['ja', 'en', 'ja-Latn', 'ko']): string {
    const primary = (kind: NameKind) => kind === 'main' || kind === 'official'
    const chain = langs.flatMap((lang) => this.preferred(id, lang) ?? [])
    const names = this.card(id)?.names ?? []
    return (
      chain.find((name) => primary(name.kind))?.text ??
      names
        .filter((name) => primary(name.kind))
        .sort(
          (a, b) =>
            Number(a.text.includes('(')) - Number(b.text.includes('(')) ||
            Number(a.source === 'danbooru') - Number(b.source === 'danbooru'),
        )[0]?.text ??
      chain[0]?.text ??
      names[0]?.text ??
      id
    )
  }

  kin(id: string, text: string): string[] {
    const held = flat(text)
    const found: string[] = []
    const seen = new Set([id])
    let frontier = [id]
    for (let hop = 1; hop <= 2; hop++) {
      const next: string[] = []
      for (const from of frontier) {
        for (const { other } of this.union<{ other: string }>('SELECT other FROM related WHERE work = ?', from)) {
          if (seen.has(other)) continue
          seen.add(other)
          next.push(other)
          found.push(other)
        }
      }
      frontier = next
    }
    const holds = 'SELECT 1 AS found FROM names WHERE entity = ? AND instr(flat, ?) > 0 LIMIT 1'
    return found.filter((other) => this.union(holds, other, held).length > 0)
  }

  homonyms(query: string, kind: Kind): number {
    const rows = this.union<{ entity: string }>(
      'SELECT entity FROM names WHERE flat = ? AND ekind = ?',
      flat(query),
      kind,
    )
    return new Set(rows.map((row) => row.entity)).size
  }
}
