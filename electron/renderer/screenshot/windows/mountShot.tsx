import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material'
import '@fontsource-variable/inter'
import { BRAND_PRIMARY } from '../../theme/brand'
import AreaOverlay from './AreaOverlay'
import Pin from './Pin'
import Thumbnail from './Thumbnail'
import WindowPicker from './WindowPicker'
import Editor from '../editor/Editor'

export type ShotRoute = 'shot-area' | 'shot-editor' | 'shot-thumb' | 'shot-pin' | 'shot-windows'

/*
 * The screenshot windows. Like the recorder's overlays they skip the app's
 * stylesheet and theme: a plain dark MUI theme, and a transparent page for the
 * frameless ones (thumbnail, pin).
 */
const theme = createTheme({
  palette: { mode: 'dark', primary: { main: BRAND_PRIMARY }, background: { default: '#1e1e24', paper: '#2a2a32' } },
  typography: { fontFamily: '"Inter Variable", system-ui, sans-serif' },
  shape: { borderRadius: 8 }
})

export const mountShot = (route: ShotRoute): void => {
  const transparent = route === 'shot-thumb' || route === 'shot-pin'
  for (const el of [document.documentElement, document.body]) {
    el.style.background = transparent ? 'transparent' : route === 'shot-area' ? '#000' : '#1e1e24'
    el.style.margin = '0'
    el.style.overflow = 'hidden'
    el.style.height = '100%'
  }
  const root = document.getElementById('root')
  if (!root) return
  root.style.height = '100%'
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const id = params.get('id') ?? ''
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider theme={theme}>
        {route === 'shot-editor' && <CssBaseline />}
        {route === 'shot-area' && <AreaOverlay displayId={params.get('display') ?? ''} />}
        {route === 'shot-editor' && <Editor id={id} />}
        {route === 'shot-thumb' && <Thumbnail id={id} />}
        {route === 'shot-pin' && <Pin id={id} />}
        {route === 'shot-windows' && <WindowPicker />}
        {route === 'shot-editor' && (
          <Toaster position='bottom-center' toastOptions={{ style: { background: '#2f2f38', color: '#fff', fontSize: 13 } }} />
        )}
      </ThemeProvider>
    </StrictMode>
  )
}
