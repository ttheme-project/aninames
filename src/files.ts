import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { writeAuthority } from './authority.ts'
import {
  ADULT,
  CHARACTER,
  FORMAT,
  HASH_LENGTH,
  type KeyTable,
  NAME_KINDS,
  type Packed,
  pack,
  shared,
  TABLES,
  type Table,
  TRUSTED,
} from './client/format.ts'
import { compare } from './client/order.ts'
import { LAYERS, type Layer, type NameKind, SPINE } from './model.ts'
import { licenses, notice, TERMS } from './pack.ts'
import { contextOf, type Context as Derived, IDS, type Key, keyRows, reachOf } from './rows.ts'
import { flat, qualifiers, reversed } from './text.ts'

export const DOMAIN = 'names.ttheme.dev'

export function bound(before: string | undefined, key: string): string {
  if (before === undefined) return ''
  if (compare(before, key) >= 0) return key
  const at = shared(before, key)
  return key.slice(0, at + ((key.codePointAt(at) ?? 0) > 0xffff ? 2 : 1))
}

export class Writer {
  readonly keys: string[] = []
  readonly hashes: string[] = []
  readonly eids: number[] = []
  raw = 0
  gz = 0
  private readonly dir: string
  private readonly target: number
  private rows: string[] = []
  private size = 0
  private first: [string, number] = ['', 0]
  private last: string | undefined

  constructor(dir: string, target: number) {
    this.dir = dir
    this.target = target
    mkdirSync(dir, { recursive: true })
  }

  add(row: unknown[], key: string, eid = 0): void {
    const text = JSON.stringify(row)
    if (this.rows.length > 0 && this.size + text.length + 1 > this.target) this.flush()
    if (this.rows.length === 0) this.first = [bound(this.last, key), eid]
    this.last = key
    this.rows.push(text)
    this.size += text.length + 1
  }

  flush(): void {
    if (this.rows.length === 0) return
    const text = `[${this.rows.join(',')}]`
    const gz = gzipSync(text, { level: 9 })
    const hash = createHash('sha256').update(gz).digest('hex').slice(0, HASH_LENGTH)
    writeFileSync(join(this.dir, `${hash}.json.gz`), gz)
    this.keys.push(this.first[0])
    this.eids.push(this.first[1])
    this.hashes.push(hash)
    this.raw += Buffer.byteLength(text)
    this.gz += gz.length
    this.rows = []
    this.size = 0
  }

  packed(numbered: boolean): Packed {
    return pack(this.keys, this.hashes, numbered ? this.eids : undefined)
  }
}

interface Context extends Derived {
  out: string
  target: number
}

function keyTable(db: Database, layer: Layer, table: KeyTable, context: Context): Writer {
  const writer = new Writer(join(context.out, layer, table), context.target)
  if (table === 'tail') {
    const rows = [...keyRows(db, 'flat', context)].map(([key, ...rest]): Key => [reversed(key), ...rest])
    rows.sort((a, b) => compare(a[0], b[0]) || a[1] - b[1])
    for (const row of rows) writer.add(row, row[0])
  } else for (const row of keyRows(db, table, context)) writer.add(row, row[0])
  writer.flush()
  return writer
}

const TAG_SQL: Record<'tag' | 'home', string> = {
  tag: `SELECT entity, substr(ref, 10) AS tag, max(rank) AS posts, min(tier) AS tier FROM refs
WHERE ref GLOB 'danbooru:*' GROUP BY entity, ref
UNION ALL SELECT entity, key AS tag, NULL AS posts, tier FROM families`,
  home: `SELECT entity, tag, posts, tier FROM homes UNION ALL
SELECT c.entity, c.tag, h.posts, c.tier FROM copyrights c JOIN homes h ON h.entity = c.entity`,
}

function tagTable(db: Database, layer: Layer, table: 'tag' | 'home', context: Context): Writer {
  const { eid, masks, score } = context
  const writer = new Writer(join(context.out, layer, table), context.target)
  const rows: [key: string, at: number, posts: number, character: boolean, tier?: number][] = []
  for (const row of db
    .query<{ entity: string; tag: string; posts: number | null; tier?: number }, []>(TAG_SQL[table])
    .iterate()) {
    const at = eid.get(row.entity)
    const key = flat(qualifiers(row.tag).base)
    if (at !== undefined && key) {
      rows.push([key, at, Math.round(row.posts ?? 0), row.entity.startsWith('c/'), row.tier])
    }
  }
  rows.sort((a, b) => compare(a[0], b[0]) || a[1] - b[1] || b[2] - a[2])
  const least = new Map<string, number>()
  for (const [key, at, , , tier] of rows) {
    const id = `${key}\u0000${at}`
    if (tier !== undefined) least.set(id, Math.min(tier, least.get(id) ?? tier))
  }
  let last: [string, number] | undefined
  for (const [key, at, posts, character] of rows) {
    if (last && last[0] === key && last[1] === at) continue
    last = [key, at]
    const tier = least.get(`${key}\u0000${at}`)
    const flags = (character ? CHARACTER : 0) | (score.adult[at] ? ADULT : 0) | (masks[at] ?? 0)
    writer.add(
      [
        key,
        at,
        posts,
        flags,
        score.rank[at],
        score.standing[at],
        score.extra[at],
        ...(tier === undefined || (table === 'tag' && tier === 0) ? [] : [tier]),
      ],
      key,
    )
  }
  writer.flush()
  return writer
}

const ENTITY_SQL = `WITH ids(id) AS (${IDS})
SELECT ids.id AS id,
  (SELECT json_group_array(json_array(text, lang, kind, source, qual, pref)) FROM
    (SELECT text, lang, kind, source, qual, pref FROM names WHERE entity = ids.id ORDER BY rowid)) AS names,
  (SELECT json_group_array(json_array(substr(ref, 10), CASE WHEN own = 1 THEN rank END)) FROM
    (SELECT ref, rank, own FROM refs WHERE entity = ids.id AND ref GLOB 'danbooru:*'
      ORDER BY own DESC, rank IS NULL, rank DESC, rowid)) AS tags,
  (SELECT json_group_array(work) FROM
    (SELECT work FROM works WHERE character = ids.id GROUP BY work ORDER BY min(rowid))) AS works,
  (SELECT json_group_array(ref) FROM
    (SELECT ref FROM refs WHERE entity = ids.id AND ref NOT GLOB 'danbooru:*' GROUP BY ref ORDER BY ref)) AS refs,
  (SELECT tag FROM homes WHERE entity = ids.id) AS home,
  (SELECT json_group_array(tag) FROM copyrights WHERE entity = ids.id) AS copyrights,
  (SELECT key FROM families WHERE entity = ids.id) AS family,
  e.origin AS origin, e.year AS year, e.medium AS medium, e.genres AS genres, e.nature AS nature
FROM ids LEFT JOIN entities e ON e.id = ids.id ORDER BY ids.id`

type NameSource = [
  text: string,
  lang: string | null,
  kind: NameKind,
  source: string,
  qual: string | null,
  pref: number | null,
]

function trimmed(tail: unknown[]): unknown[] {
  const out = [...tail]
  const empty = (value: unknown) => value === null || (Array.isArray(value) && value.length === 0)
  while (out.length > 0 && empty(out.at(-1))) out.pop()
  return out
}

function entityTable(db: Database, layer: Layer, context: Context): Writer {
  const { eid, score } = context
  const writer = new Writer(join(context.out, layer, 'entity'), context.target / 2)
  const links = score.related.get(layer) ?? new Map<number, number[]>()
  const order = (at: number) => 25 * (score.standing[at] ?? 0) + 1000 * (score.extra[at] ?? 0)
  for (const row of db
    .query<
      {
        id: string
        names: string
        tags: string
        works: string
        refs: string
        home: string | null
        copyrights: string
        family: string | null
        origin: string | null
        year: number | null
        medium: string | null
        genres: string | null
        nature: string | null
      },
      []
    >(ENTITY_SQL)
    .iterate()) {
    const at = eid.get(row.id)
    if (at === undefined) continue
    const names = (JSON.parse(row.names) as NameSource[]).map(([text, lang, kind, source, qual, pref]) => {
      const code = NAME_KINDS.indexOf(kind)
      if (code < 0) throw new Error(`aninames: name kind ${kind} has no code`)
      const found = TRUSTED.indexOf(source)
      const trust = found < 0 ? TRUSTED.length : found
      if (pref !== null) return [text, lang, code, trust, qual, pref]
      return qual === null ? [text, lang, code, trust] : [text, lang, code, trust, qual]
    })
    const tags = (JSON.parse(row.tags) as [string, number | null][]).map(([tag, posts]) => [
      tag,
      posts === null ? null : Math.round(posts),
    ])
    const works = (JSON.parse(row.works) as string[]).flatMap((work) => {
      const other = eid.get(work)
      return other === undefined ? [] : [[other, work]]
    })
    const reach = row.id.startsWith('w/') ? reachOf(links, at).sort((a, b) => order(b) - order(a) || a - b) : []
    writer.add(
      [
        at,
        row.id,
        names,
        tags,
        works,
        reach,
        score.rank[at],
        score.standing[at],
        score.extra[at],
        score.adult[at],
        JSON.parse(row.refs) as string[],
        row.home,
        ...trimmed([
          row.origin ? row.origin.split(' ') : [],
          row.year,
          row.medium,
          JSON.parse(row.copyrights) as string[],
          row.genres ? row.genres.split(' ') : [],
          row.nature,
          row.family,
        ]),
      ],
      row.id,
      at,
    )
  }
  writer.flush()
  return writer
}

const html = (text: string) =>
  text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch)

async function page(built: string): Promise<string> {
  const sections = (await licenses()).flatMap(([layer, lines]) => [
    `<h2>${html(layer)}</h2>`,
    '<ul>',
    ...lines.map((line) => `<li>${html(line)}</li>`),
    '</ul>',
  ])
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>aninames</title>',
    '<h1>aninames</h1>',
    `<p>The search keys of <a href="https://github.com/ttheme-project/aninames">aninames</a>, a multilingual alias index for anime titles and characters, as sorted gzip'd JSON files for its client library. Built ${html(built)}; the files are listed in <a href="manifest.json">manifest.json</a>.</p>`,
    `<p>${html(TERMS)}</p>`,
    ...sections,
    '',
  ].join('\n')
}

function builtAt(db: Database): string {
  return db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'built'").get()?.value ?? ''
}

export async function chunk(dir: string, target = 32_768): Promise<void> {
  const started = performance.now()
  const dbs = new Map<Layer, Database>()
  for (const layer of LAYERS) {
    const path = join(dir, `${layer}.sqlite`)
    if (existsSync(path)) dbs.set(layer, new Database(path, { readonly: true }))
  }
  const spine = dbs.get(SPINE)
  if (!spine) throw new Error(`aninames: ${join(dir, `${SPINE}.sqlite`)} is missing; run mise run build`)
  const out = join(dir, 'site')
  rmSync(out, { recursive: true, force: true })
  const context: Context = { ...contextOf(dbs), out, target }
  const built = builtAt(spine)
  const layers: Partial<Record<Layer, Record<Table, Packed>>> = {}
  let files = 0
  let gz = 0
  for (const [layer, db] of dbs) {
    const tables = {} as Record<Table, Packed>
    for (const table of TABLES) {
      const writer =
        table === 'entity'
          ? entityTable(db, layer, context)
          : table === 'tag' || table === 'home'
            ? tagTable(db, layer, table, context)
            : keyTable(db, layer, table, context)
      tables[table] = writer.packed(table === 'entity')
      files += writer.hashes.length
      gz += writer.gz
      console.log(
        `chunk: ${layer}/${table} ${writer.hashes.length} files, ${(writer.raw / 2 ** 20).toFixed(1)} MB raw, ${(writer.gz / 2 ** 20).toFixed(1)} MB gz`,
      )
    }
    layers[layer] = tables
    db.close()
  }
  const manifest = JSON.stringify({ aninames: FORMAT, built, layers })
  writeFileSync(join(out, 'manifest.json'), manifest)
  writeAuthority(join(out, 'authority.json'))
  writeFileSync(join(out, 'CNAME'), `${DOMAIN}\n`)
  writeFileSync(join(out, 'NOTICE.md'), await notice())
  writeFileSync(join(out, 'index.html'), await page(built))
  const packed = gzipSync(manifest, { level: 9 }).length
  console.log(
    `chunk: ${files} files, ${(gz / 2 ** 20).toFixed(1)} MB gz; manifest ${(manifest.length / 1024).toFixed(0)} KB raw, ${(packed / 1024).toFixed(0)} KB gz in ${((performance.now() - started) / 1000).toFixed(0)} s to ${out}`,
  )
}
