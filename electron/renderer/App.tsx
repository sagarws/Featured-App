import { useState } from 'react'
import { Toaster } from 'react-hot-toast'
import { Box } from '@mui/material'
import type { AgentState } from '@shared/types/agent'
import Sidebar, { firstPage, pageEnabled, type Page } from './layout/Sidebar'
import TopBar from './layout/TopBar'
import HomePage from './pages/HomePage'
import SettingsPage from './pages/SettingsPage'
import RecorderPage from './recorder/RecorderPage'
import ScreenshotPage from './screenshot/ScreenshotPage'
import FileSharePage from './fileshare/FileSharePage'
import TranscriptPage from './transcriber/TranscriptPage'
import RemoteDesktopPage from './remote/RemoteDesktopPage'
import VpsManagerPage from './vps/VpsManagerPage'
import SystemAudioPermissionDialog from './recorder/components/SystemAudioPermissionDialog'

const App = ({ state }: { state: AgentState }) => {
  const access = state.featureAccess
  const [chosen, setChosen] = useState<Page | null>(() => firstPage(access))
  // A tab switched off while open (or none chosen yet): show the first one allowed instead.
  const page = chosen !== null && pageEnabled(access, chosen) ? chosen : firstPage(access)
  // Disabled tabs (feature-access.json) cannot be opened from anywhere.
  const setPage = (next: Page) => {
    if (pageEnabled(access, next)) setChosen(next)
  }
  const [query, setQuery] = useState('')

  const search = (value: string) => {
    setQuery(value)
    // Search filters the Home screen; typing from Settings takes you there.
    if (value && page !== 'home') setPage('home')
  }

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Sidebar page={page} onNavigate={setPage} state={state} />
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <TopBar query={query} onQueryChange={search} jobs={state.jobs} onOpenSettings={() => setPage('settings')} />
        <Box component='main' sx={{ flex: 1, overflow: 'auto', px: 5, py: 5 }}>
          {page === 'home' && <HomePage state={state} query={query} />}
          {page === 'screenshots' && <ScreenshotPage state={state} />}
          {page === 'fileshare' && <FileSharePage />}
          {page === 'recorder' && <RecorderPage />}
          {page === 'transcripts' && <TranscriptPage />}
          {page === 'remote' && <RemoteDesktopPage />}
          {page === 'vps' && <VpsManagerPage />}
          {page === 'settings' && <SettingsPage state={state} />}
          {page === null && <Box sx={{ color: 'text.secondary', textAlign: 'center', mt: 10 }}>No features are switched on for this computer.</Box>}
        </Box>
      </Box>
      {/* The recorder reports through react-hot-toast. */}
      <Toaster position='top-right' />
      {/* macOS: ask for the system-audio permission the recorder needs. */}
      <SystemAudioPermissionDialog />
    </Box>
  )
}

export default App
