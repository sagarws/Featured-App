import { useState } from 'react'
import { Toaster } from 'react-hot-toast'
import { Box } from '@mui/material'
import type { AgentState } from '@shared/types/agent'
import Sidebar, { type Page } from './layout/Sidebar'
import TopBar from './layout/TopBar'
import HomePage from './pages/HomePage'
import SettingsPage from './pages/SettingsPage'
import RecorderPage from './recorder/RecorderPage'
import ScreenshotPage from './screenshot/ScreenshotPage'
import TranscriptPage from './transcriber/TranscriptPage'
import SystemAudioPermissionDialog from './recorder/components/SystemAudioPermissionDialog'

const App = ({ state }: { state: AgentState }) => {
  const [page, setPage] = useState<Page>('home')
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
          {page === 'recorder' && <RecorderPage />}
          {page === 'transcripts' && <TranscriptPage />}
          {page === 'settings' && <SettingsPage state={state} />}
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
