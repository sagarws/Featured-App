import defaults from './sidebarFeatures.json'

/*
 * Which features show in the sidebar.
 *
 * sidebarFeatures.json holds the DEFAULTS for a fresh install (Home and
 * Screenshots only). The live values are kept per computer in the app-data
 * folder (feature-access.json, see electron/main/featureAccess.ts) and are
 * changed from the app: click the "Featured App" logo in the sidebar 5 times,
 * enter the access password (MAIN_VITE_FEATURE_ACCESS_PASSWORD in .env), then
 * toggle each tab. `true` shows the tab, `false` hides it — and its page cannot
 * be opened any other way either.
 *
 *   home         Home (printers and jobs)
 *   screenshots  Screenshots
 *   fileshare    File Share
 *   recorder     Recorder
 *   transcripts  Transcripts
 *   remote       Remote Desktop
 *   vps          VPS Manager
 *   settings     Settings
 */
export type SidebarFeature = keyof typeof defaults

export type FeatureAccess = Record<SidebarFeature, boolean>

export const SIDEBAR_FEATURES = Object.keys(defaults) as SidebarFeature[]

export const DEFAULT_FEATURE_ACCESS: FeatureAccess = { ...defaults }

export const isSidebarFeature = (id: unknown): id is SidebarFeature =>
  typeof id === 'string' && (SIDEBAR_FEATURES as string[]).includes(id)

/** Stored values over the defaults; anything missing or not a boolean takes its default. */
export const sanitiseFeatureAccess = (raw: unknown): FeatureAccess => {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const access = { ...DEFAULT_FEATURE_ACCESS }
  for (const id of SIDEBAR_FEATURES) {
    if (typeof value[id] === 'boolean') access[id] = value[id]
  }
  return access
}
