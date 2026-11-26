/**
 * A site's images: the files its SoC facts and an SDK's boot steps stage (a boot ROM helper, a probe image), which
 * live in the copy's `.blobs/` by sha256 out of git. The `boardctrl` CLI fetches them (`boardctrl images sync`), and a host gets
 * them with the site. Kept out of `site.ts`: this is about the files, not the catalog.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'

export interface ImagesState {
  at: string, ok: boolean, message: string
  /** `<soc>/<image>` */
  fetched: string[], present: string[], failed: Array<{ image: string, error: string }>
  /** Listed with no file in any layer and no source to fetch it from, and staged by an SDK's or SoC's boot steps. */
  missing: string[]
  /**
   * Listed with no file and no source, and staged by nothing but discovery (a SoC's probe images): nothing fails
   * without them, a board found is just not told apart by model.
   */
  optional?: string[]
}

type Data = Record<string, unknown>
interface Run { code: number, stdout: string, stderr: string }
const isData = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown) => value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
const last = (run: Run) => (run.stderr || run.stdout).trim().split('\n').filter(Boolean).at(-1) ?? `退出码 ${run.code}`

/** What the images code needs from the site it belongs to. */
export interface ImagesSite {
  dir: string
  options: { bin?: string }
  settings: { get(key: string): string | null, set(key: string, value: string): void }
  /** The layers the hosts read, lowest first (the site's is last). */
  layers(): Array<{ name: string, root: string }>
  /** The site's documents as they load, for the SDK boot steps that stage images. */
  documents(): Data[]
  exec(command: string, args: string[], cwd: string | undefined, env?: NodeJS.ProcessEnv): Promise<Run>
  sshCommands(): Promise<string[]>
}

/**
 * The images something stages besides discovery, as `<soc>/<image>` (`any/<image>` for an SDK with no SoC): an SDK's
 * boot steps (`image:` of its SoC) and a SoC's media boot steps, in any layer.
 */
export function usedImages(site: ImagesSite): Set<string> {
  const used = new Set<string>()
  const steps = (value: unknown): Data[] => Array.isArray(value) ? value.filter(isData) : []
  for (const doc of site.documents()) {
    const boot = isData(doc.boot) ? doc.boot : {}
    for (const method of Object.values(boot)) for (const step of steps(isData(method) ? method.steps : null))
      if (typeof step.image === 'string') used.add(`${typeof doc.soc === 'string' ? doc.soc : 'any'}/${step.image}`)
  }
  for (const layer of site.layers()) {
    const at = join(layer.root, 'socs')
    if (!existsSync(at)) continue
    for (const soc of readdirSync(at)) {
      let profile: unknown = null
      try { profile = parse(readFileSync(join(at, soc, 'soc.yaml'), 'utf8')) } catch { continue }
      const media = isData(profile) && isData(profile.media_boot) ? profile.media_boot : {}
      for (const step of steps(media.steps)) if (typeof step.image === 'string') used.add(`${soc}/${step.image}`)
    }
  }
  return used
}

/**
 * Fetch the images the SoC facts list into the copy's `.blobs/` with the boardctrl CLI (each way into git over ssh in
 * turn while some fail), and say what is still not there. Never throws: what went wrong is in the result, and kept.
 */
export async function fetchImages(site: ImagesSite, say: (line: string) => void = () => {}): Promise<ImagesState | null> {
  const bin = site.options.bin
  if (!bin) return null
  // This copy is the CLI's site; no user file of the CLI's, so no registry layer the hosts would not have.
  const noRemotes = join(dirname(site.dir), 'no-remotes.json')
  const env = { BSP_SITE: site.dir, BOARDCTRL_SITE: site.dir, BSP_CONFIG: noRemotes, BOARDCTRL_CONFIG: noRemotes }
  const answer = (run: Run): { ok?: boolean, result?: unknown, error?: { message?: string } } | null => { try { return JSON.parse(run.stdout) } catch { return null } }
  const ways = await site.sshCommands()
  const fetched = new Set<string>()
  let got: { present: string[], failed: ImagesState['failed'] } | null = null, error = ''
  for (const ssh of ways.length ? ways : [null]) {
    const run = await site.exec(bin, ['--json', 'images', 'sync'], site.dir, { ...env, ...(ssh ? { GIT_SSH_COMMAND: ssh } : {}) })
    const out = answer(run)
    if (!out?.ok || !isData(out.result)) { error = out?.error?.message ?? last(run); break }
    const result = out.result as { fetched?: string[], present?: string[], failed?: ImagesState['failed'] }
    for (const name of result.fetched ?? []) { if (!fetched.has(name)) say(`取到了镜像 ${name}`); fetched.add(name) }
    got = { present: (result.present ?? []).filter(name => !fetched.has(name)), failed: result.failed ?? [] }
    if (!got.failed.length) break
  }
  // Images nobody can fetch: missing when a boot step stages them, optional when only discovery does.
  const missing: string[] = [], optional: string[] = []
  if (got) {
    const listed = answer(await site.exec(bin, ['--json', 'images', 'list'], site.dir, env))
    const used = usedImages(site)
    if (listed?.ok && Array.isArray(listed.result)) for (const row of (listed.result as Data[]).filter(row => row.state === 'missing')) {
      const name = `${str(row.soc)}/${str(row.image)}（${str(row.file)}）`
      if (used.has(`${str(row.soc)}/${str(row.image)}`) || used.has(`any/${str(row.image)}`)) missing.push(name)
      else optional.push(name)
    }
  }
  const failed = got?.failed ?? [], have = fetched.size + (got?.present.length ?? 0)
  for (const item of failed) say(`镜像 ${item.image} 没取到：${item.error}`)
  for (const name of missing) say(`镜像 ${name} 有启动步骤要用，却哪儿都没有，也没写从哪取`)
  const message = !got ? `没取成镜像：${error}`
    : !have && !failed.length && !missing.length ? '没有要取的镜像'
    : [`镜像 ${have} 个在${fetched.size ? `（新取到 ${fetched.size} 个）` : ''}`, failed.length ? `${failed.length} 个没取到` : '', missing.length ? `${missing.length} 个缺` : ''].filter(Boolean).join('，')
  const state: ImagesState = { at: new Date().toISOString(), ok: !!got && !failed.length && !missing.length, message, fetched: [...fetched], present: got?.present ?? [], failed, missing, optional }
  site.settings.set('images', JSON.stringify(state))
  return state
}
