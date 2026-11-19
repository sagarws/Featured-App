import { useState } from 'react'
import { Box, Button, Chip, FormControlLabel, IconButton, LinearProgress, Menu, MenuItem, Paper, Stack, Switch, Tooltip, Typography } from '@mui/material'
import { ContentCopyOutlined, DeleteOutline, ExpandLessRounded, ExpandMoreRounded, FileDownloadOutlined, StopCircleOutlined } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { TranscriptExportFormat, TranscriptJob, TranscriptStatus } from '@shared/types/transcriber'
import { formatClock, toPlainText } from '@shared/utils/transcriber'
import ConfirmDialog from '../recorder/components/ConfirmDialog'

const STATUS: Record<TranscriptStatus, { label: string; color: 'success' | 'warning' | 'error' | 'info' | 'default' }> = {
  queued: { label: 'Waiting', color: 'default' },
  downloading: { label: 'Downloading model', color: 'info' },
  transcribing: { label: 'Transcribing', color: 'info' },
  done: { label: 'Done', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  cancelled: { label: 'Cancelled', color: 'warning' }
}

const FORMATS: { value: TranscriptExportFormat; label: string }[] = [
  { value: 'txt', label: 'Text (.txt)' },
  { value: 'srt', label: 'Subtitles (.srt)' },
  { value: 'vtt', label: 'Web subtitles (.vtt)' }
]

const dateLabel = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

const TranscriptCard = ({ job, expanded, onToggle }: { job: TranscriptJob; expanded: boolean; onToggle: () => void }) => {
  const api = window.printAgent.transcriber
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [times, setTimes] = useState(true)
  const running = job.status === 'queued' || job.status === 'downloading' || job.status === 'transcribing'
  const status = STATUS[job.status]
  const hasText = job.segments.length > 0

  const copy = async () => {
    await navigator.clipboard.writeText(toPlainText(job.segments, times))
    toast.success('Transcript copied.')
  }

  const save = async (format: TranscriptExportFormat) => {
    setMenu(null)
    const result = await api.exportFile(job.id, format)
    if (!result.ok) toast.error(result.error)
    else if (result.value) toast.success('Transcript saved.')
  }

  const call = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const result = await fn()
    if (!result.ok) toast.error(result.error ?? 'Something went wrong.')
  }

  return (
    <Paper variant='outlined' sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Stack direction='row' alignItems='center' spacing={2} sx={{ p: 3 }}>
        <Box sx={{ flex: 1, minWidth: 0, cursor: hasText ? 'pointer' : 'default' }} onClick={hasText ? onToggle : undefined}>
          <Typography sx={{ fontWeight: 600, fontSize: 15 }} noWrap title={job.sourcePath}>
            {job.fileName}
          </Typography>
          <Stack direction='row' spacing={1} alignItems='center' sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.75 }}>
            <Chip size='small' color={status.color} label={status.label} variant={job.status === 'done' ? 'filled' : 'outlined'} />
            <Chip size='small' variant='outlined' label={job.language === 'hi' ? 'Hindi' : 'English'} />
            <Chip size='small' variant='outlined' label={job.model === 'fast' ? 'Fast' : 'High accuracy'} />
            {job.durationSec !== null && (
              <Typography variant='caption' color='text.secondary'>
                {formatClock(job.durationSec)}
              </Typography>
            )}
            <Typography variant='caption' color='text.secondary'>
              {dateLabel(job.createdAt)}
            </Typography>
          </Stack>
        </Box>

        {running && (
          <Tooltip title='Cancel'>
            <IconButton onClick={() => void call(() => api.cancel(job.id))}>
              <StopCircleOutlined />
            </IconButton>
          </Tooltip>
        )}
        {hasText && (
          <>
            <Tooltip title='Copy text'>
              <IconButton onClick={() => void copy()}>
                <ContentCopyOutlined />
              </IconButton>
            </Tooltip>
            <Tooltip title='Download'>
              <IconButton onClick={e => setMenu(e.currentTarget)} disabled={running}>
                <FileDownloadOutlined />
              </IconButton>
            </Tooltip>
          </>
        )}
        <Tooltip title='Delete'>
          <IconButton onClick={() => setConfirm(true)}>
            <DeleteOutline />
          </IconButton>
        </Tooltip>
        {hasText && <IconButton onClick={onToggle}>{expanded ? <ExpandLessRounded /> : <ExpandMoreRounded />}</IconButton>}
      </Stack>

      {(job.status === 'downloading' || job.status === 'transcribing') && (
        <Box sx={{ px: 3, pb: 3 }}>
          <Stack direction='row' justifyContent='space-between' sx={{ mb: 0.75 }}>
            <Typography variant='caption' color='text.secondary'>
              {job.status === 'downloading' ? 'Downloading the speech model (first time only)…' : 'Converting speech to text…'}
            </Typography>
            <Typography variant='caption' color='text.secondary'>
              {Math.round(job.progress * 100)}%
            </Typography>
          </Stack>
          <LinearProgress variant='determinate' value={job.progress * 100} />
        </Box>
      )}
      {job.status === 'queued' && (
        <Box sx={{ px: 3, pb: 3 }}>
          <LinearProgress />
        </Box>
      )}
      {job.error && (
        <Typography variant='body2' color='error' sx={{ px: 3, pb: 3 }}>
          {job.error}
        </Typography>
      )}

      {expanded && hasText && (
        <Box sx={{ borderTop: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
          <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ px: 3, pt: 2 }}>
            <FormControlLabel control={<Switch size='small' checked={times} onChange={e => setTimes(e.target.checked)} />} label={<Typography variant='body2'>Timestamps</Typography>} />
            <Button size='small' startIcon={<ContentCopyOutlined />} onClick={() => void copy()}>
              Copy all
            </Button>
          </Stack>
          <Box sx={{ px: 3, pb: 3, pt: 1, maxHeight: 420, overflow: 'auto', userSelect: 'text' }}>
            {job.segments.map((s, i) => (
              <Stack key={i} direction='row' spacing={2} sx={{ py: 0.75 }}>
                {times && (
                  <Typography variant='body2' color='text.secondary' sx={{ fontVariantNumeric: 'tabular-nums', minWidth: 56, flexShrink: 0 }}>
                    {formatClock(s.start)}
                  </Typography>
                )}
                <Typography variant='body2' sx={{ lineHeight: 1.7 }} lang={job.language}>
                  {s.text}
                </Typography>
              </Stack>
            ))}
          </Box>
        </Box>
      )}

      <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
        {FORMATS.map(f => (
          <MenuItem key={f.value} onClick={() => void save(f.value)}>
            {f.label}
          </MenuItem>
        ))}
      </Menu>
      <ConfirmDialog
        open={confirm}
        title='Delete transcript?'
        message={running ? 'This stops the transcription and removes it. The original file is not touched.' : 'The transcript is removed from the app. The original file is not touched.'}
        confirmLabel='Delete'
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false)
          void call(() => api.remove(job.id))
        }}
      />
    </Paper>
  )
}

export default TranscriptCard
