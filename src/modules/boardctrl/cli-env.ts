/** What `boardctrl` commands read from the environment, under both its name and the older `bsp` one. */
import { existsSync } from 'node:fs'
import { hostUrl } from './address.ts'

/** The environment a `boardctrl` command runs with: each value under its `BOARDCTRL_*` name and its older `BSP_*` one,
 *  so a host's boardctrl may be either (and a hook or script there keeps reading `BSP_*`). */
export function cliEnv(input: { config: { url: string, password?: string | null }, site: string | null, sshKey?: string | null, direct: boolean, url: string }): NodeJS.ProcessEnv {
  const { config, site } = input, both = (name: string, value: string) => ({ [`BSP_${name}`]: value, [`BOARDCTRL_${name}`]: value })
  const ssh = input.sshKey && hostUrl(config.url).startsWith('ssh://') ? `-i ${input.sshKey} -o IdentitiesOnly=yes` : null
  const registry = config.url && !input.direct ? input.url : null
  return { ...process.env, ...(site && existsSync(site) ? both('SITE', site) : {}), ...(registry ? both('REGISTRY', registry) : {}),
    ...(config.password ? both('TOKEN', config.password) : {}), ...(ssh ? both('SSH_OPTIONS', ssh) : {}) }
}
