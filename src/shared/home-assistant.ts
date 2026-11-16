export interface HaSettings {
  /** boardd uses the Home Assistant controller; off, its slots are hidden and never pressed (boards stay listed). */
  enabled: boolean
  url: string | null
  hasToken: boolean
  verifiedAt: string | null
  verifyOk: boolean | null
  verifyMessage: string | null
}

export interface HaCandidate { slot: number, resetEntity: string | null, fastbootEntity: string | null, device: string | null }
export interface HaDiscovery { devices: Array<{ id: string, name: string }>, slots: HaCandidate[], unassigned: string[] }
