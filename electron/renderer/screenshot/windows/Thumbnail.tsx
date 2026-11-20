import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, CircularProgress, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { Close, CloudUploadOutlined, ContentCopy, Edit, PushPinOutlined, SaveOutlined } from '@mui/icons-material'
import type { ExportAction } from '@shared/types/screenshot'
import { useCaptureUrl } from './useCapture'

/**
 * The small preview in the screen corner after an area capture. Click to
 * edit, drag it into another app, or use the buttons. It hides itself after
 * the time set in Screenshots → General, unless the pointer is on it.
 */
const Thumbnail = ({ id }: { id: string }) => {
  const api = window.printAgent.screenshot
  const { url, error } = useCaptureUrl(id)
  const [timeout, setTimeoutSeconds] = useState<number | null>(null)
  const [uploadReady, setUploadReady] = useState(false)
  const [hover, setHover] = useState(false)
  const [busy, setBusy] = useState<ExportAction | null>(null)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void api.editorSettings().then(r => {
      if (!r.ok) return
      setTimeoutSeconds(r.value.thumbnailTimeout)
      setUploadReady(r.value.uploadReady)
    })
  }, [api])

  const close = useCallback(() => void api.closeSelf(), [api])

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (!timeout || hover || busy) return
    timer.current = setTimeout(close, timeout * 1000)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [timeout, hover, busy, close, message])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  useEffect(() => {
    if (error) close()
  }, [error, close])

  const run = async (action: ExportAction) => {
    setBusy(action)
    setMessage(null)
    const result = await api.exportImage(id, action)
    setBusy(null)
    if (!result.ok) setMessage({ text: result.error, error: true })
    else if (action === 'copy') setMessage({ text: 'Copied' })
    else if (action === 'save') setMessage({ text: 'Saved' })
    else if (action === 'upload') setMessage({ text: result.value.link ? 'Link copied' : 'Uploaded' })
    else if (action === 'pin') close()
  }

  const button = (action: ExportAction, title: string, icon: ReactNode) => (
    <Tooltip title={title} key={action}>
      <IconButton size='small' onClick={() => void run(action)} disabled={!!busy} sx={{ color: '#fff', bgcolor: 'rgba(0,0,0,0.55)', '&:hover': { bgcolor: 'rgba(0,0,0,0.75)' } }}>
        {busy === action ? <CircularProgress size={16} color='inherit' /> : icon}
      </IconButton>
    </Tooltip>
  )

  return (
    <Box
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      sx={{ position: 'fixed', inset: 4, borderRadius: 2.5, overflow: 'hidden', bgcolor: '#1e1e24', boxShadow: '0 6px 24px rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.15)' }}
    >
      {url && (
        <Box
          component='img'
          src={url}
          alt='Screenshot'
          draggable
          onDragStart={e => {
            e.preventDefault()
            api.startDrag(id)
          }}
          onClick={() => void api.openEditor(id)}
          sx={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', cursor: 'pointer' }}
        />
      )}
      {(hover || busy) && (
        <>
          <Stack direction='row' spacing={0.75} sx={{ position: 'absolute', left: 8, bottom: 8 }}>
            {button('copy', 'Copy', <ContentCopy sx={{ fontSize: 16 }} />)}
            {button('save', 'Save', <SaveOutlined sx={{ fontSize: 16 }} />)}
            {uploadReady && button('upload', 'Upload and copy link', <CloudUploadOutlined sx={{ fontSize: 16 }} />)}
            {button('pin', 'Pin', <PushPinOutlined sx={{ fontSize: 16 }} />)}
            <Tooltip title='Edit'>
              <IconButton size='small' onClick={() => void api.openEditor(id)} sx={{ color: '#fff', bgcolor: 'primary.main', '&:hover': { bgcolor: 'primary.dark' } }}>
                <Edit sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Stack>
          <IconButton size='small' onClick={close} sx={{ position: 'absolute', top: 6, right: 6, color: '#fff', bgcolor: 'rgba(0,0,0,0.55)', '&:hover': { bgcolor: 'rgba(0,0,0,0.75)' } }}>
            <Close sx={{ fontSize: 16 }} />
          </IconButton>
        </>
      )}
      {message && (
        <Typography
          sx={{ position: 'absolute', top: 8, left: 8, px: 1, py: 0.25, borderRadius: 1, fontSize: 12, color: '#fff', bgcolor: message.error ? 'error.main' : 'success.main', maxWidth: 'calc(100% - 48px)' }}
          noWrap
          title={message.text}
        >
          {message.text}
        </Typography>
      )}
    </Box>
  )
}

export default Thumbnail
