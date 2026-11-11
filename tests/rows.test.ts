import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { indexes, schema } from '../src/build.ts'
import { Names } from '../src/client/names.ts'
import { fileSource } from '../src/client/source.ts'
import { chunk } from '../src/files.ts'
import { contextOf } from '../src/rows.ts'
import { Index } from '../src/search.ts'
import { flat, latinKey } from '../src/text.ts'

function fixture(dir: string): Database {
  const db = new Database(join(dir, 'unlicensed.sqlite'), { create: true })
  schema(db)
  const entity = db.prepare('INSERT INTO entities (id, kind, medium, type) VALUES (?, ?, ?, ?)')
  const name = db.prepare(
    "INSERT INTO names (entity, ekind, text, lang, kind, source, flat, latin, variant, support) VALUES (?, ?, ?, 'en', 'main', 'bangumi', ?, ?, 0, 1)",
  )
  const add = (id: string, text: string, medium: string | null = null) => {
    const kind = id.startsWith('w/') ? 'work' : 'character'
    entity.run(id, kind, medium, medium === 'anime' ? 'TV' : null)
    name.run(id, kind, text, flat(text), latinKey(text))
  }
  add('w/x:1', 'Starfall', 'manga')
  add('w/x:2', 'Starfall Encore', 'anime')
  add('w/x:3', 'Tidepool', 'anime')
  add('w/x:4', 'New Starfall', 'anime')
  add('w/x:5', '星降る夜', 'anime')
  add('w/x:6', 'Gekijouban Starfall Re', 'anime')
  add('c/x:1', 'Pip')
  add('c/x:2', 'Pip')
  const tie = db.prepare('INSERT INTO related (work, other) VALUES (?, ?)')
  const ties: [string, string][] = [
    ['w/x:1', 'w/x:2'],
    ['w/x:2', 'w/x:4'],
    ['w/x:1', 'w/x:6'],
  ]
  for (const [a, b] of ties) {
    tie.run(a, b)
    tie.run(b, a)
  }
  const cast = db.prepare('INSERT INTO works (character, work) VALUES (?, ?)')
  cast.run('c/x:1', 'w/x:4')
  cast.run('c/x:2', 'w/x:3')
  db.run("INSERT INTO ranks (entity, rank) VALUES ('w/x:2', 0.9), ('w/x:1', 0.5), ('c/x:2', 0.8)")
  db.run("INSERT INTO meta (key, value) VALUES ('built', '2026-01-01T00:00:00.000Z')")
  indexes(db)
  return db
}

test('a work carries the first of its family and a character the families of its works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aninames-'))
  try {
    const db = fixture(dir)
    const { eid, kin, score } = contextOf(new Map([['unlicensed', db]]))
    const at = (id: string) => eid.get(id) as number
    expect(kin.get(at('w/x:1'))).toEqual([at('w/x:1')])
    expect(kin.get(at('w/x:2'))).toEqual([at('w/x:1')])
    expect(kin.get(at('w/x:4'))).toEqual([at('w/x:1')])
    expect(kin.get(at('w/x:3'))).toBeUndefined()
    expect(kin.get(at('c/x:1'))).toEqual([at('w/x:1')])
    expect(kin.get(at('c/x:2'))).toEqual([at('w/x:3')])
    expect([score.book[at('w/x:1')], score.book[at('w/x:2')]]).toEqual([1, 0])
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the files and SQLite give the same answers, and a family lifts its works whose names hold the query', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aninames-'))
  try {
    fixture(dir).close()
    await chunk(dir, 512)
    const index = new Index(dir, ['unlicensed'])
    for (const query of ['starfall', 'pip starfall', 'pip tidepool', 'tarfall', 'satrfall', '降る夜']) {
      const names = new Names(fileSource(join(dir, 'site')))
      const found = (await names.search(query)).map((card) => card.id)
      expect([query, ...index.search(query).map((hit) => hit.id)]).toEqual([query, ...found])
      expect(found.length).toBeGreaterThan(0)
    }
    const names = new Names(fileSource(join(dir, 'site')))
    expect((await names.search('pip starfall')).map((card) => card.id)).toEqual(['c/x:1'])
    expect((await names.search('pip tidepool')).map((card) => card.id)).toEqual(['c/x:2'])
    expect((await names.search('starfall', { kind: 'work' })).map((card) => card.id)).toEqual([
      'w/x:2',
      'w/x:6',
      'w/x:4',
      'w/x:1',
    ])
    index.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
