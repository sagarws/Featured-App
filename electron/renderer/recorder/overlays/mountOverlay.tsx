import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import '@fontsource-variable/inter'
import RecordingToolbar from './RecordingToolbar'
import RegionSelector from './RegionSelector'
import CameraBubble from './CameraBubble'
import RegionBorder from './RegionBorder'

/*
 * The recorder's small windows. They are transparent and frameless, so they
 * skip the app's stylesheet and CssBaseline (both paint a background) and use
 * a plain dark MUI theme instead.
 */
const theme = createTheme({
  palette: { mode: 'dark', primary: { main: '#7367F0' }, error: { main: '#FF4C51' } },
  typography: { fontFamily: '"Inter Variable", system-ui, sans-serif' },
  shape: { borderRadius: 10 }
})

export const mountOverlay = (route: 'toolbar' | 'region' | 'border' | 'camera'): void => {
  for (const el of [document.documentElement, document.body]) {
    el.style.background = 'transparent'
    el.style.margin = '0'
    el.style.overflow = 'hidden'
    el.style.height = '100%'
  }
  const root = document.getElementById('root')
  if (!root) return
  root.style.height = '100%'
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider theme={theme}>
        {route === 'toolbar' && <RecordingToolbar />}
        {route === 'region' && <RegionSelector displayId={params.get('display') ?? ''} />}
        {route === 'border' && <RegionBorder />}
        {route === 'camera' && <CameraBubble />}
      </ThemeProvider>
    </StrictMode>
  )
}
