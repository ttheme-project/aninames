import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { LAYERS, type Layer, type Source } from './model.ts'
import { pick } from './sources/index.ts'
import { rawDir } from './stage.ts'

const LEVEL = 6

export const TERMS =
  'Each layer is its own file and keeps the terms of the sources it was built from; combine them on your own machine.'

export async function dated(sources: Source[]): Promise<Map<string, string>> {
  const days = new Map<string, string>()
  for (const source of sources) {
    const day = await source.dated?.(rawDir(source))
    if (day) days.set(source.name, day)
  }
  return days
}

export async function licenses(sources?: Source[]): Promise<[Layer, string[]][]> {
  const all = sources ?? (await pick([]))
  const days = await dated(all)
  const line = ({ name, license }: Source) =>
    `${name}: ${license}${days.has(name) ? `, data of ${days.get(name)}` : ''}`
  return LAYERS.map((layer) => [layer, all.filter((source) => source.layer === layer).map(line)])
}

export async function notice(): Promise<string> {
  return [
    '# aninames data',
    '',
    TERMS,
    '',
    ...(await licenses()).flatMap(([layer, lines]) => [`## ${layer}`, '', ...lines.map((line) => `- ${line}`), '']),
  ].join('\n')
}

export async function pack(dir: string): Promise<void> {
  const target = join(dir, 'release')
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  let before = 0
  let after = 0
  const note = (name: string, from: number, to: number) => {
    before += from
    after += to
    console.log(`pack: ${name} ${(from / 1e6).toFixed(1)} MB → ${(to / 1e6).toFixed(1)} MB`)
  }
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sqlite')).sort()) {
    const data = await Bun.file(join(dir, name)).bytes()
    const packed = Bun.zstdCompressSync(data, { level: LEVEL })
    await Bun.write(join(target, `${name}.zst`), packed)
    note(name, data.byteLength, packed.byteLength)
  }
  await Bun.write(join(target, 'NOTICE.md'), await notice())
  console.log(`pack: ${(before / 1e6).toFixed(0)} MB → ${(after / 1e6).toFixed(0)} MB in ${target}`)
}
