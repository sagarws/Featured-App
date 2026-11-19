export type PrimaryColorConfig = {
  name?: string
  light?: string
  main: string
  dark?: string
}

/*
 * The presets, IN ORDER — and the first one is what a fresh installation gets
 * (see settingsContext's `defaultSettings`), so this list's order is a shipped
 * decision, not a layout preference.
 *
 * THE ICON COLOUR IS FIRST, which makes it the default and the one Reset
 * returns to: the blue-violet of the app icon (BRAND_PRIMARY in
 * theme/brand.ts — keep the two equal). `defaultSettings()` in the settings
 * context reads THIS list's first entry, and Reset and the "have the settings
 * changed?" check both use it, so the default lives here and nowhere else.
 *
 * Ink (near-black) and TrackVid's teal are still here as presets.
 */
const primaryColorConfig: PrimaryColorConfig[] = [
  {
    // The app icon's blue-violet (build/icon.png).
    name: 'primary-brand',
    light: '#7380FF',
    main: '#4353FF',
    dark: '#2F3BD6'
  },
  {
    // Near-black. `light` and `dark` bracket it so the hover and pressed states
    // have somewhere to go — at #171717 a "darker" press is almost the same
    // colour, so the lift is upward instead.
    name: 'primary-ink',
    light: '#3D3D3D',
    main: '#171717',
    dark: '#0A0A0A'
  },
  {
    name: 'primary-2',
    light: '#4EB0B1',
    main: '#0D9394',
    dark: '#096B6C'
  },
  {
    name: 'primary-1',
    light: '#8F85F3',
    main: '#7367F0',
    dark: '#675DD8'
  },
  {
    name: 'primary-3',
    light: '#FFC25A',
    main: '#FFAB1D',
    dark: '#BA7D15'
  },
  {
    name: 'primary-4',
    light: '#F0718D',
    main: '#EB3D63',
    dark: '#AC2D48'
  },
  {
    name: 'primary-5',
    light: '#5CAFF1',
    main: '#2092EC',
    dark: '#176BAC'
  }
]

export default primaryColorConfig
