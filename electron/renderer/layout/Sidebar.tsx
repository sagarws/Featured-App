import type { ReactNode } from 'react'
import { Box, ButtonBase, Stack, Typography } from '@mui/material'
import { ConnectedTvOutlined, CropFree, DnsOutlined, FiberSmartRecordOutlined, FolderSharedOutlined, SubtitlesOutlined } from '@mui/icons-material'
import type { AgentState } from '@shared/types/agent'
import { isFeatureEnabled } from '@shared/constants/sidebarFeatures'
import { SIDEBAR } from '../theme/brand'
import logo from '../assets/app-icon.png'

export type Page = 'home' | 'screenshots' | 'fileshare' | 'recorder' | 'transcripts' | 'remote' | 'vps' | 'settings'

// A Tabler class from styles/icons.css, or a component for icons not in that set.
const ALL_NAV: { id: Page; label: string; icon: string | ReactNode }[] = [
  { id: 'home', label: 'Home', icon: 'tabler-smart-home' },
  { id: 'screenshots', label: 'Screenshots', icon: <CropFree sx={{ fontSize: 20 }} /> },
  { id: 'fileshare', label: 'File Share', icon: <FolderSharedOutlined sx={{ fontSize: 20 }} /> },
  { id: 'recorder', label: 'Recorder', icon: <FiberSmartRecordOutlined sx={{ fontSize: 20 }} /> },
  { id: 'transcripts', label: 'Transcripts', icon: <SubtitlesOutlined sx={{ fontSize: 20 }} /> },
  { id: 'remote', label: 'Remote Desktop', icon: <ConnectedTvOutlined sx={{ fontSize: 20 }} /> },
  { id: 'vps', label: 'VPS Manager', icon: <DnsOutlined sx={{ fontSize: 20 }} /> },
  { id: 'settings', label: 'Settings', icon: 'tabler-settings' }
]

/** The sidebar items switched on in shared/constants/sidebarFeatures.json, in sidebar order. */
export const NAV = ALL_NAV.filter(item => isFeatureEnabled(item.id))

/** Can this page be shown? (Switched off in sidebarFeatures.json = no.) */
export const pageEnabled = (page: Page): boolean => NAV.some(item => item.id === page)

/** Where the app opens: Home, or the first enabled feature. */
export const firstPage = (): Page | null => (pageEnabled('home') ? 'home' : (NAV[0]?.id ?? null))

const Sidebar = ({ page, onNavigate, state }: { page: Page | null; onNavigate: (page: Page) => void; state: AgentState }) => {
  const online = state.server.state === 'listening'
  const starting = state.server.state === 'starting'

  return (
    <Box
      component='aside'
      sx={theme => ({
        width: SIDEBAR.width,
        flexShrink: 0,
        bgcolor: SIDEBAR.bg,
        color: SIDEBAR.text,
        display: 'flex',
        flexDirection: 'column',
        px: 3,
        py: 4,
        position: 'sticky',
        top: 0,
        height: '100vh',
        ...theme.applyStyles('dark', { bgcolor: SIDEBAR.bgDark, borderInlineEnd: `1px solid ${SIDEBAR.panelBorder}` })
      })}
    >
      <Stack direction='row' spacing={1.5} alignItems='center' sx={{ px: 1.5, mb: 6 }}>
        <Box component='img' src={logo} alt='' sx={{ width: 32, height: 32, borderRadius: '8px' }} />
        <Typography sx={{ color: '#fff', fontSize: 20, fontWeight: 700, letterSpacing: -0.3 }}>Featured App</Typography>
      </Stack>

      <Stack component='nav' spacing={1} aria-label='Main'>
        {NAV.map(item => {
          const active = item.id === page
          return (
            <ButtonBase
              key={item.id}
              onClick={() => onNavigate(item.id)}
              aria-current={active ? 'page' : undefined}
              sx={{
                justifyContent: 'flex-start',
                gap: 2,
                px: 2,
                py: 1.5,
                borderRadius: 2,
                fontSize: 14,
                fontWeight: active ? 600 : 500,
                color: active ? '#fff' : SIDEBAR.text,
                bgcolor: active ? 'primary.main' : 'transparent',
                boxShadow: active ? '0 6px 16px -6px rgb(var(--mui-palette-primary-mainChannel) / 0.7)' : 'none',
                '&:hover': { bgcolor: active ? 'primary.main' : SIDEBAR.hover }
              }}
            >
              {typeof item.icon === 'string' ? <i className={item.icon} style={{ fontSize: 20 }} /> : item.icon}
              {item.label}
            </ButtonBase>
          )
        })}
      </Stack>

      <Box sx={{ flex: 1 }} />

      <Box
        sx={{
          p: 2.5,
          borderRadius: 2,
          bgcolor: SIDEBAR.panel,
          border: `1px solid ${SIDEBAR.panelBorder}`,
          mb: 4
        }}
      >
        <Stack direction='row' spacing={1.5} alignItems='center'>
          <Box
            sx={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              flexShrink: 0,
              bgcolor: online ? 'success.main' : starting ? 'warning.main' : 'error.main',
              boxShadow: theme =>
                `0 0 0 3px ${online ? theme.vars?.palette.success.lightOpacity : theme.vars?.palette.error.lightOpacity}`
            }}
          />
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>
              {online ? 'System Online' : starting ? 'Starting…' : 'Agent Offline'}
            </Typography>
            <Typography sx={{ color: SIDEBAR.textMuted, fontSize: 11.5 }}>
              {online ? 'All services are running' : starting ? 'Opening the print service' : 'Printing is unavailable'}
            </Typography>
          </Box>
        </Stack>
      </Box>

      <Typography sx={{ color: SIDEBAR.textMuted, fontSize: 12, px: 1.5 }}>v{state.version}</Typography>
    </Box>
  )
}

export default Sidebar
