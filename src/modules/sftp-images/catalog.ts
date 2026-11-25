/** Offers the sftp-images module to boardd: image markets over directories on build servers reached by ssh. */
import type { CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { hostsFor } from '../hosts/ssh.ts'
import { sftpImages } from './index.ts'

export const entry: CatalogEntry = {
  id: 'sftp-images', about: '构建服务器目录的镜像市场（ssh；市场本身在站点或设置里配）',
  create: (_settings, context) => sftpImages(access => hostsFor(context.stateDir).reach(access)),
}
