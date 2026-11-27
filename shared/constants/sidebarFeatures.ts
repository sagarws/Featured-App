import features from './sidebarFeatures.json'

/*
 * Which features show in the sidebar. Edit sidebarFeatures.json: `true` shows
 * the feature, `false` (or a missing key) hides it — and its page cannot be
 * opened any other way either. Takes effect on the next build / dev reload.
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
export type SidebarFeature = keyof typeof features

const flags: Record<string, unknown> = features

export const isFeatureEnabled = (id: string): boolean => flags[id] === true
