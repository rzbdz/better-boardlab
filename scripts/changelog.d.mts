export interface PreviousRelease { revision: string, version: string }

export declare function previousRelease(cwd?: string, out?: string, version?: string | null): PreviousRelease | null
export declare function isCandidate(version: string): boolean
export declare function subjectsSince(from: string, to?: string, cwd?: string): string[]
export declare function changelog(version: string, revision: string | null, subjects: string[], options?: { date?: string, since?: string }): string
