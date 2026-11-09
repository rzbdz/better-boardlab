import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../src/boardlab.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

describe('boardlab install -g', () => {
  it('injects the skill into every installed agent, replacing older copies', async () => {
    const home = join(dir, 'home')
    for (const path of ['.claude/skills/boards', '.codex', '.config/opencode']) mkdirSync(join(home, path), { recursive: true })
    const was = process.env.HOME
    process.env.HOME = home
    const lines: string[] = []
    const log = console.log
    console.log = (line: string) => lines.push(line)
    try { await main(['install', '-g']) } finally { console.log = log; process.env.HOME = was }
    for (const path of ['.claude/skills', '.codex/skills', '.config/opencode/skill']) expect(readFileSync(join(home, path, 'boardlab/SKILL.md'), 'utf8')).toMatch(/^name: boardlab$/m)
    expect(existsSync(join(home, '.claude/skills/boards'))).toBe(false)
    expect(existsSync(join(home, '.hermes'))).toBe(false)
    expect(lines.at(-1)).toBe('覆盖了旧版本：Claude Code')
  })
})

describe('boardlab install', () => {
  it('writes the skill into a directory, keeping a SKILL.md that is not boardlab\'s', async () => {
    const target = join(dir, 'work')
    mkdirSync(target)
    writeFileSync(join(target, 'SKILL.md'), '# another tool')
    const log = console.log
    console.log = () => {}
    try { await main(['install', '--dir', target]) } finally { console.log = log }
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toMatch(/^name: boardlab$/m)
    expect(readFileSync(join(target, 'SKILL.md.bak'), 'utf8')).toBe('# another tool')
    expect(existsSync(join(target, 'boot.md'))).toBe(true)
  })
})
