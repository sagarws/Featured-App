import { useState } from 'react'
import { Alert, AlertTitle, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItem, ListItemText, Stack, Typography } from '@mui/material'
import toast from 'react-hot-toast'
import type { RecordingSummary } from '@shared/types/recorder'
import { formatBytes, formatDuration } from '@shared/utils/recorder'
import ConfirmDialog from './ConfirmDialog'

/**
 * "An interrupted recording was detected. Would you like to recover it?"
 * One per interrupted session: Recover, View saved segments, Discard.
 */
const RecoveryBanner = ({ sessions, onChanged }: { sessions: RecordingSummary[]; onChanged: () => void }) => {
  const recorder = window.printAgent.recorder
  const [busy, setBusy] = useState<string | null>(null)
  const [viewing, setViewing] = useState<RecordingSummary | null>(null)
  const [discarding, setDiscarding] = useState<RecordingSummary | null>(null)

  const recover = async (s: RecordingSummary) => {
    setBusy(s.id)
    const r = await recorder.recover(s.id)
    setBusy(null)
    if (r.ok) {
      const skipped = r.value.skipped.length
      toast.success(skipped ? `Recovered. ${skipped} unreadable segment(s) were skipped and kept on disk.` : 'Recording recovered.')
    } else {
      toast.error(`Recovery failed: ${r.error}`)
    }
    onChanged()
  }

  const discard = async (s: RecordingSummary) => {
    setDiscarding(null)
    const r = await recorder.remove(s.id)
    if (r.ok) toast.success('Interrupted recording moved to the trash.')
    else toast.error(r.error)
    onChanged()
  }

  if (sessions.length === 0) return null
  return (
    <Stack spacing={2}>
      {sessions.map(s => (
        <Alert
          key={s.id}
          severity='warning'
          action={
            <Stack direction='row' spacing={1} sx={{ alignSelf: 'center' }}>
              <Button size='small' variant='contained' color='warning' disabled={busy !== null} onClick={() => void recover(s)}>
                {busy === s.id ? 'Recovering…' : 'Recover Recording'}
              </Button>
              <Button size='small' color='inherit' onClick={() => setViewing(s)}>
                View Saved Segments
              </Button>
              <Button size='small' color='inherit' disabled={busy === s.id} onClick={() => setDiscarding(s)}>
                Discard Session
              </Button>
            </Stack>
          }
        >
          <AlertTitle>An interrupted recording was detected. Would you like to recover it?</AlertTitle>
          {s.name} — {s.segments.length} segment file(s), {formatBytes(s.bytes)} on disk, about {formatDuration(s.duration)} recorded.
        </Alert>
      ))}

      <Dialog open={!!viewing} onClose={() => setViewing(null)} maxWidth='sm' fullWidth>
        <DialogTitle>Saved segments</DialogTitle>
        <DialogContent>
          <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
            These files are on disk in {viewing?.dir}. Recovery checks each one, repairs a cut-short last segment, and joins them in order. Nothing is deleted until
            the joined file is verified.
          </Typography>
          <List dense>
            {viewing?.segments.map(seg => (
              <ListItem key={seg.file} divider>
                <ListItemText
                  primary={seg.file}
                  secondary={`${formatBytes(seg.bytes)} · ${seg.end !== null && seg.start !== null ? `${formatDuration(seg.end - seg.start)} (finished)` : 'not finished — will be repaired'}`}
                />
              </ListItem>
            ))}
            {viewing?.segments.length === 0 && <Box sx={{ py: 2, color: 'text.secondary' }}>No segment files were written before the interruption.</Box>}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => viewing && void recorder.openLocation(viewing.id)}>Open folder</Button>
          <Button variant='contained' onClick={() => setViewing(null)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!discarding}
        title='Discard this interrupted recording?'
        message='The session folder and all its segments will be moved to the trash.'
        confirmLabel='Discard'
        onCancel={() => setDiscarding(null)}
        onConfirm={() => discarding && void discard(discarding)}
      />
    </Stack>
  )
}

export default RecoveryBanner
