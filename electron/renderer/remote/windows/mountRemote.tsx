import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CssBaseline } from '@mui/material'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import '@fontsource-variable/inter'
import { BRAND_PRIMARY } from '../../theme/brand'
import HostBar from './HostBar'
import RequestPrompt from './RequestPrompt'

/*
 * Remote Desktop's own windows. The viewer and the request prompt are dark
 * windows with a plain MUI theme in the brand colour; the host bar is
 * transparent; the capture window has no UI.
 */
const theme = createTheme({
  palette: { mode: 'dark', primary: { main: BRAND_PRIMARY }, background: { default: '#1b1c22', paper: '#22232b' } },
  typography: { fontFamily: '"Inter Variable", system-ui, sans-serif', button: { textTransform: 'none', fontWeight: 600 } },
  shape: { borderRadius: 8 }
})

export const mountRemote = async (route: 'rd-viewer' | 'rd-host' | 'rd-hostbar' | 'rd-request'): Promise<void> => {
  if (route === 'rd-host') {
    const { runHostEngine } = await import('../host/engine')
    return runHostEngine()
  }
  const root = document.getElementById('root')
  if (!root) return
  const transparent = route === 'rd-hostbar'
  for (const el of [document.documentElement, document.body, root]) {
    el.style.margin = '0'
    el.style.height = '100%'
    el.style.overflow = 'hidden'
    if (transparent) el.style.background = 'transparent'
  }
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const Viewer = route === 'rd-viewer' ? (await import('../viewer/Viewer')).default : null
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider theme={theme}>
        {!transparent && <CssBaseline />}
        {Viewer && <Viewer />}
        {route === 'rd-hostbar' && <HostBar />}
        {route === 'rd-request' && <RequestPrompt requestId={params.get('id') ?? ''} />}
      </ThemeProvider>
    </StrictMode>
  )
}
