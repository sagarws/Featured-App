import type { VpsChange, VpsPlatform } from '@shared/types/vps'

export interface SetupParams {
  username: string
  port: number
  firewall: boolean
  /** Re-enable an account the app made earlier (kept on disconnect) instead of creating one. */
  reuseUser: boolean
}

export interface TeardownParams {
  username: string
  port: number
  /** What setup recorded; only these are undone (plus anything carrying the app's own names). */
  changes: VpsChange[]
  removeUser: boolean
}

export interface PlatformAdapter {
  id: VpsPlatform
  /** Root-owned folder holding the server's config, log and guard state (readable by everyone, no secrets). */
  serverDir: string
  /** Can this machine run the server, and if not, why? */
  support: () => Promise<{ ok: boolean; reason: string | null }>
  setupScript: (p: SetupParams) => string
  teardownScript: (p: TeardownParams) => string
  /** Set a new password (from the work folder's `secret`) and lift a lockout. */
  passwordScript: (username: string) => string
}
