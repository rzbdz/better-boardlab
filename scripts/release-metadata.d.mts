import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'

export interface CoreReleaseMetadata {
  version: string
  revision: string
  tag: string
}

export declare function releaseVersion(packageVersion: string, requested?: string): string
export declare function releaseMetadata(input: {
  version: string
  revision: string
  file: string
  sha256: string
  core: CoreReleaseMetadata
}): {
  version: string
  revision: string
  file: string
  sha256: string
  core: CoreReleaseMetadata
}
export declare function verifyStablePublication(input: {
  root?: string
  release: { version: string, revision: string }
  git?: (...args: string[]) => string
}): string
export declare function verifyStagedRelease(input: {
  stage: string
  version: string
  revision: string
  core?: CoreReleaseMetadata
  run?: (command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string
}): { version: string, revision: string }
