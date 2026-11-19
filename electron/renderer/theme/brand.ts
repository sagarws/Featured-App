/**
 * The agent's own look on top of the ported theme, taken from the app icon
 * (build/icon.png): an electric blue-violet accent from the middle of the
 * icon's blue → violet gradient, a cyan-blue for info notices from its top-left
 * glow, and a deep navy sidebar from its background that stays dark in both
 * schemes.
 */
export const BRAND_PRIMARY = '#4353FF'

/** Info alerts and chips: the icon's bright blue, so a notice never reads as a button. */
export const BRAND_INFO = '#0A8CF0'

export const SIDEBAR = {
  width: 240,
  bg: '#0B1446',
  bgDark: '#060B2B',
  text: 'rgb(226 232 240 / 0.82)',
  textMuted: 'rgb(148 163 184 / 0.9)',
  hover: 'rgb(255 255 255 / 0.06)',
  panel: 'rgb(255 255 255 / 0.05)',
  panelBorder: 'rgb(255 255 255 / 0.08)'
} as const

export const USER = { name: 'Local User', initials: 'LU' } as const
