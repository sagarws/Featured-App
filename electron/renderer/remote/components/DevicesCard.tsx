import { useState } from 'react'
import { Box, Button, Chip, IconButton, Paper, Stack, Tab, Tabs, TextField, Tooltip, Typography } from '@mui/material'
import { DeleteOutline, EditOutlined, KeyOffOutlined, KeyOutlined, RefreshOutlined, ReplayOutlined, Star, StarBorder } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { RemoteStatus } from '@shared/types/remote'
import { platformLabel } from '@shared/utils/remote'
import { timeAgo } from '../hooks'

type View = 'network' | 'saved' | 'recent'

/** Devices on this office network, saved devices (pinned keys) and recent connections. */
const DevicesCard = ({ status, onPick, onReconnect }: { status: RemoteStatus; onPick: (id: string) => void; onReconnect: (id: string) => void }) => {
  const api = window.printAgent.remote
  const [view, setView] = useState<View>(status.discovered.length ? 'network' : 'saved')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const online = new Set(status.discovered.map(d => d.id))
  const withPassword = new Set(status.savedPasswords)
  const saved = [...status.saved].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))
  const recent = status.saved.filter(d => d.lastConnectedAt).sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0)).slice(0, 10)

  const act = async (call: Promise<{ ok: boolean; error?: string }>) => {
    const r = await call
    if (!r.ok) toast.error(r.error ?? 'Failed')
  }

  const rows =
    view === 'network'
      ? status.discovered.map(d => ({ id: d.id, name: d.name, detail: `${d.os || platformLabel(d.platform)} · ${d.address}`, online: true, saved: status.saved.find(s => s.id === d.id) }))
      : (view === 'saved' ? saved : recent).map(d => ({
          id: d.id,
          name: d.name,
          detail: `${d.os}${d.address ? ` · ${d.address}` : ''} · last connected ${timeAgo(d.lastConnectedAt)}`,
          online: online.has(d.id),
          saved: d
        }))

  return (
    <Paper variant='outlined' sx={{ p: 3, borderRadius: 3 }}>
      <Stack direction='row' alignItems='center' sx={{ mb: 1 }}>
        <Tabs value={view} onChange={(_e, v: View) => setView(v)} sx={{ flex: 1, minHeight: 36, '& .MuiTab-root': { minHeight: 36 } }}>
          <Tab value='network' label={`On this network (${status.discovered.length})`} />
          <Tab value='saved' label={`Saved (${status.saved.length})`} />
          <Tab value='recent' label='Recent' />
        </Tabs>
        <Tooltip title='Look for devices again'>
          <IconButton onClick={() => void act(api.refreshDiscovery())}>
            <RefreshOutlined />
          </IconButton>
        </Tooltip>
      </Stack>

      {!rows.length && (
        <Typography variant='body2' color='text.secondary' sx={{ py: 4, textAlign: 'center' }}>
          {view === 'network'
            ? status.settings.lanDiscovery
              ? 'No other computers found yet. They appear here when the app is open on them, on the same network, with LAN discovery on.'
              : 'LAN discovery is off (Settings).'
            : 'Devices you connect to are saved here, with their security key.'}
        </Typography>
      )}

      <Stack divider={<Box sx={{ borderBlockEnd: '1px solid', borderColor: 'divider' }} />}>
        {rows.map(row => (
          <Stack key={row.id} direction='row' alignItems='center' spacing={1.5} sx={{ py: 1.25 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: row.online ? 'success.main' : 'action.disabled' }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {renaming?.id === row.id ? (
                <TextField
                  size='small'
                  autoFocus
                  value={renaming.name}
                  onChange={e => setRenaming({ id: row.id, name: e.target.value })}
                  onBlur={() => {
                    void act(api.updateDevice(row.id, { name: renaming.name }))
                    setRenaming(null)
                  }}
                  onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
              ) : (
                <Typography noWrap sx={{ fontWeight: 600, fontSize: 14 }}>
                  {row.name} <Chip size='small' variant='outlined' label={row.id} sx={{ ml: 1, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', height: 20 }} />
                  {withPassword.has(row.id) && (
                    <Tooltip title='Password saved: Reconnect connects without asking'>
                      <KeyOutlined color='action' sx={{ fontSize: 16, ml: 1, verticalAlign: 'middle' }} />
                    </Tooltip>
                  )}
                </Typography>
              )}
              <Typography variant='caption' color='text.secondary' noWrap component='div'>
                {row.detail}
              </Typography>
            </Box>
            {row.saved && (
              <>
                <Tooltip title={row.saved.favorite ? 'Unfavourite' : 'Favourite'}>
                  <IconButton size='small' onClick={() => void act(api.updateDevice(row.id, { favorite: !row.saved!.favorite }))}>
                    {row.saved.favorite ? <Star fontSize='small' color='warning' /> : <StarBorder fontSize='small' />}
                  </IconButton>
                </Tooltip>
                <Tooltip title='Rename'>
                  <IconButton size='small' onClick={() => setRenaming({ id: row.id, name: row.name })}>
                    <EditOutlined fontSize='small' />
                  </IconButton>
                </Tooltip>
                {withPassword.has(row.id) && (
                  <Tooltip title='Forget saved password'>
                    <IconButton size='small' onClick={() => void act(api.forgetSavedPassword(row.id))}>
                      <KeyOffOutlined fontSize='small' />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title='Forget (also forgets its pinned security key and saved password)'>
                  <IconButton size='small' onClick={() => void act(api.forgetDevice(row.id))}>
                    <DeleteOutline fontSize='small' />
                  </IconButton>
                </Tooltip>
              </>
            )}
            <Tooltip title={withPassword.has(row.id) ? 'Reconnect with the saved password' : 'Reconnect (asks the person there to accept)'}>
              <IconButton size='small' onClick={() => onReconnect(row.id)}>
                <ReplayOutlined fontSize='small' />
              </IconButton>
            </Tooltip>
            <Button size='small' variant='outlined' onClick={() => onPick(row.id)}>
              Use
            </Button>
          </Stack>
        ))}
      </Stack>
    </Paper>
  )
}

export default DevicesCard
