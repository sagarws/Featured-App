import { useState, type ReactNode } from 'react'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import {
  CallMergeOutlined,
  DeleteOutline,
  DriveFileRenameOutline,
  FileDownloadOutlined,
  FolderOpenOutlined,
  GraphicEqOutlined,
  MoreVert,
  PlayArrowRounded,
  VideocamOutlined,
  VideoLibraryOutlined,
  DesktopWindowsOutlined
} from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { RecordingKind, RecordingSummary, SessionStatus } from '@shared/types/recorder'
import { formatBytes, formatDuration, mediaUrl } from '@shared/utils/recorder'
import ConfirmDialog from './ConfirmDialog'

const KIND: Record<RecordingKind, { label: string; icon: ReactNode }> = {
  screen: { label: 'Screen', icon: <DesktopWindowsOutlined /> },
  webcam: { label: 'Webcam', icon: <VideocamOutlined /> },
  audio: { label: 'Audio', icon: <GraphicEqOutlined /> }
}

const STATUS: Partial<Record<SessionStatus, { label: string; color: 'success' | 'warning' | 'error' | 'info' | 'default' }>> = {
  complete: { label: 'Saved', color: 'success' },
  stopped: { label: 'Segments only', color: 'info' },
  merging: { label: 'Saving…', color: 'info' },
  recording: { label: 'Recording', color: 'error' },
  paused: { label: 'Paused', color: 'warning' },
  starting: { label: 'Starting', color: 'info' },
  stopping: { label: 'Saving…', color: 'info' },
  interrupted: { label: 'Interrupted', color: 'warning' },
  failed: { label: 'Needs attention', color: 'error' }
}

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const Thumb = ({ r }: { r: RecordingSummary }) => (
  <Box
    sx={{
      width: 128,
      height: 72,
      flexShrink: 0,
      borderRadius: 2,
      overflow: 'hidden',
      bgcolor: 'action.hover',
      display: 'grid',
      placeItems: 'center',
      color: 'text.secondary'
    }}
  >
    {r.thumbnail ? <img src={mediaUrl(r.thumbnail)} alt='' style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : KIND[r.kind].icon}
  </Box>
)

const RecordingsLibrary = ({ recordings, onChanged }: { recordings: RecordingSummary[]; onChanged: () => void }) => {
  const recorder = window.printAgent.recorder
  const [filter, setFilter] = useState<'all' | RecordingKind>('all')
  const [playing, setPlaying] = useState<RecordingSummary | null>(null)
  const [renaming, setRenaming] = useState<{ r: RecordingSummary; name: string } | null>(null)
  const [deleting, setDeleting] = useState<RecordingSummary | null>(null)
  const [menu, setMenu] = useState<{ anchor: HTMLElement; r: RecordingSummary } | null>(null)
  const [merging, setMerging] = useState<string | null>(null)

  const act = async (promise: Promise<{ ok: boolean; error?: string }>, success?: string) => {
    const r = await promise
    if (!r.ok) toast.error(r.error ?? 'Failed')
    else if (success) toast.success(success)
    onChanged()
  }

  const merge = async (r: RecordingSummary) => {
    setMerging(r.id)
    await act(recorder.merge(r.id), 'Segments joined into one file.')
    setMerging(null)
  }

  const exportFile = async (r: RecordingSummary) => {
    const result = await recorder.exportFile(r.id)
    if (!result.ok) toast.error(result.error)
    else if (result.value) toast.success(`Exported to ${result.value}`)
  }

  const shown = recordings.filter(r => r.status !== 'interrupted' && (filter === 'all' || r.kind === filter))

  return (
    <Paper variant='outlined' sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Stack direction='row' alignItems='center' sx={{ px: 3, py: 2, borderBlockEnd: '1px solid', borderColor: 'divider' }}>
        <Typography variant='h6' sx={{ fontSize: 16, fontWeight: 600, flex: 1 }}>
          Recordings
        </Typography>
        <ToggleButtonGroup size='small' exclusive value={filter} onChange={(_e, v: 'all' | RecordingKind | null) => v && setFilter(v)}>
          <ToggleButton value='all'>All</ToggleButton>
          <ToggleButton value='screen'>Screen</ToggleButton>
          <ToggleButton value='webcam'>Webcam</ToggleButton>
          <ToggleButton value='audio'>Audio</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {shown.length === 0 ? (
        <Stack alignItems='center' spacing={1} sx={{ py: 8, color: 'text.secondary' }}>
          <VideoLibraryOutlined sx={{ fontSize: 48, opacity: 0.5 }} />
          <Typography sx={{ fontWeight: 600 }}>No recordings yet</Typography>
          <Typography variant='body2'>Start a screen, webcam or audio recording above — it will appear here.</Typography>
        </Stack>
      ) : (
        <Stack divider={<Box sx={{ borderBlockEnd: '1px solid', borderColor: 'divider' }} />}>
          {shown.map(r => {
            const status = STATUS[r.status]
            const playable = !!r.file
            return (
              <Stack key={r.id} direction='row' spacing={2.5} alignItems='center' sx={{ px: 3, py: 2 }}>
                <Thumb r={r} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 600 }} noWrap title={r.name}>
                    {r.name}
                  </Typography>
                  <Stack direction='row' spacing={1.5} alignItems='center' sx={{ color: 'text.secondary', fontSize: 13, mt: 0.5, flexWrap: 'wrap' }}>
                    <span>{KIND[r.kind].label}</span>
                    <span>·</span>
                    <span>{formatDuration(r.duration)}</span>
                    <span>·</span>
                    <span>{formatBytes(r.bytes)}</span>
                    <span>·</span>
                    <span>{dateLabel(r.createdAt)}</span>
                    {status && r.status !== 'complete' && <Chip size='small' variant='tonal' color={status.color} label={status.label} />}
                  </Stack>
                  {r.note && (
                    <Typography variant='caption' color={r.status === 'failed' ? 'error' : 'text.secondary'} sx={{ display: 'block', mt: 0.5 }}>
                      {r.note}
                    </Typography>
                  )}
                </Box>
                <Stack direction='row' spacing={0.5}>
                  {!playable && (r.status === 'stopped' || r.status === 'failed') && r.segments.length > 0 && (
                    <Button size='small' variant='tonal' startIcon={<CallMergeOutlined />} disabled={merging !== null} onClick={() => void merge(r)}>
                      {merging === r.id ? 'Merging…' : 'Merge'}
                    </Button>
                  )}
                  <Tooltip title='Play'>
                    <span>
                      <IconButton disabled={!playable} onClick={() => setPlaying(r)} aria-label='Play'>
                        <PlayArrowRounded />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title='Open file location'>
                    <IconButton onClick={() => void act(recorder.openLocation(r.id))} aria-label='Open file location'>
                      <FolderOpenOutlined />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title='More'>
                    <IconButton onClick={e => setMenu({ anchor: e.currentTarget, r })} aria-label='More options'>
                      <MoreVert />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
            )
          })}
        </Stack>
      )}

      <Menu open={!!menu} anchorEl={menu?.anchor} onClose={() => setMenu(null)}>
        <MenuItem
          onClick={() => {
            if (menu) setRenaming({ r: menu.r, name: menu.r.name })
            setMenu(null)
          }}
        >
          <ListItemIcon>
            <DriveFileRenameOutline fontSize='small' />
          </ListItemIcon>
          Rename
        </MenuItem>
        <MenuItem
          disabled={!menu?.r.file}
          onClick={() => {
            if (menu) void exportFile(menu.r)
            setMenu(null)
          }}
        >
          <ListItemIcon>
            <FileDownloadOutlined fontSize='small' />
          </ListItemIcon>
          Export / Download…
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) void act(recorder.openLocation(menu.r.id))
            setMenu(null)
          }}
        >
          <ListItemIcon>
            <FolderOpenOutlined fontSize='small' />
          </ListItemIcon>
          Show in folder
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) setDeleting(menu.r)
            setMenu(null)
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon>
            <DeleteOutline fontSize='small' color='error' />
          </ListItemIcon>
          Delete
        </MenuItem>
      </Menu>

      <Dialog open={!!playing} onClose={() => setPlaying(null)} maxWidth='md' fullWidth>
        <DialogTitle>{playing?.name}</DialogTitle>
        <DialogContent>
          {playing?.file &&
            (playing.kind === 'audio' ? (
              <audio src={mediaUrl(playing.file)} controls autoPlay style={{ width: '100%' }} />
            ) : (
              <video src={mediaUrl(playing.file)} controls autoPlay style={{ width: '100%', maxHeight: '70vh', background: '#000', borderRadius: 8 }} />
            ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPlaying(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!renaming} onClose={() => setRenaming(null)} maxWidth='xs' fullWidth>
        <DialogTitle>Rename recording</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            sx={{ mt: 1 }}
            label='Name'
            value={renaming?.name ?? ''}
            onChange={e => renaming && setRenaming({ ...renaming, name: e.target.value })}
            onKeyDown={e => {
              if (e.key === 'Enter' && renaming) {
                void act(recorder.rename(renaming.r.id, renaming.name))
                setRenaming(null)
              }
            }}
            slotProps={{ htmlInput: { maxLength: 120 } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenaming(null)}>Cancel</Button>
          <Button
            variant='contained'
            disabled={!renaming?.name.trim()}
            onClick={() => {
              if (renaming) void act(recorder.rename(renaming.r.id, renaming.name))
              setRenaming(null)
            }}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        title='Delete this recording?'
        message={`"${deleting?.name ?? ''}" and its folder will be moved to the trash.`}
        confirmLabel='Delete'
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) void act(recorder.remove(deleting.id), 'Moved to the trash.')
          setDeleting(null)
        }}
      />
    </Paper>
  )
}

export default RecordingsLibrary
