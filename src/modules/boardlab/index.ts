/**
 * The `boardlab` module: host boardds as backends. A hub boardd (one that serves many hosts) lists each host boardd's
 * boards and forwards every request to it; each instance is one host (`instances`), reached at its settings' address.
 */
import type { Module } from 'boardlab-core/core/module.ts'
import { hostLab, type HostOptions } from './driver.ts'

export function boardlabHosts(options: HostOptions & { instances?: string[] } = {}): Module {
  return {
    id: 'boardlab',
    title: 'boardlab 主机',
    setup(lab) {
      for (const id of options.instances ?? []) lab.backends.register(id, hostLab(options))
    },
  }
}
