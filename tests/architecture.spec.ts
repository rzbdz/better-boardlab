import { describe, expect, it } from 'vitest'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error: a plain ES module script without type declarations
import { checkArchitecture } from '../core/scripts/check-architecture.mjs'

type Violation = { file: string, line: number, rule: string, message: string }
const root = join(import.meta.dirname, '..')
const listed = (dir: string) => (checkArchitecture(dir) as Violation[]).map(item => `${item.file} ${item.rule}: ${item.message}`)

describe('architecture', () => {
  it('holds for the distribution', () => {
    expect(checkArchitecture(root) as Violation[]).toEqual([])
  })

  it('catches modules reaching past what they may use', () => {
    const copy = mkdtempSync(join(tmpdir(), 'arch-'))
    try {
      cpSync(join(root, 'architecture.json'), join(copy, 'architecture.json'))
      cpSync(join(root, 'src'), join(copy, 'src'), { recursive: true })
      const write = (path: string, text: string) => { mkdirSync(join(copy, path, '..'), { recursive: true }); writeFileSync(join(copy, path), text) }
      // A module using another it neither declares nor requires, and reaching into the core's page.
      write('src/modules/home-assistant/leak.ts', "import { bsp } from '../bsp/index.ts'\nimport { mountPage } from 'boardlab-core/ui/main.tsx'\nexport { bsp, mountPage }\n")
      // A module's commands using the core's server side, and its page part a module's server side.
      appendFileSync(join(copy, 'src/modules/script-slots/cli.ts'), "\nimport { BoardLab } from 'boardlab-core/core/lab.ts'\nexport { BoardLab }\n")
      appendFileSync(join(copy, 'src/modules/script-slots/ui.tsx'), "\nimport { LOCAL } from '../local/index.ts'\nexport { LOCAL }\n")
      // A module nobody declared, set up under another id and offered to boardd by no catalog entry.
      write('src/modules/zigbee/index.ts', "export const zigbee = { id: 'zb', setup() {} }\n")
      expect(listed(copy)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^src\/modules\/home-assistant\/leak\.ts modules: module home-assistant imports module bsp without declaring it/),
        expect.stringMatching(/^src\/modules\/home-assistant\/leak\.ts layers: modules may not import ui \(core\/src\/ui\/main\.tsx\)/),
        expect.stringMatching(/^src\/modules\/home-assistant\/index\.ts modules: module home-assistant uses module bsp but does not list it in requires/),
        expect.stringMatching(/^src\/modules\/script-slots\/cli\.ts layers: module-cli may not import core \(core\/src\/core\/lab\.ts\)/),
        expect.stringMatching(/^src\/modules\/script-slots\/ui\.tsx layers: module-ui may not import modules \(src\/modules\/local\/index\.ts\)/),
        expect.stringMatching(/^src\/modules\/zigbee modules: module zigbee is not declared/),
        expect.stringMatching(/^src\/modules\/zigbee\/index\.ts modules: module zigbee must set itself up with id 'zigbee'/),
        expect.stringMatching(/^src\/modules\/zigbee modules: module zigbee has no catalog\.ts/),
      ]))
    } finally { rmSync(copy, { recursive: true, force: true }) }
  })
})
