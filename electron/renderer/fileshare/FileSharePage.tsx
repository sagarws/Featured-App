import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import {
  Close,
  CloudUploadOutlined,
  DeleteOutline,
  DownloadOutlined,
  EditNoteOutlined,
  GridViewOutlined,
  InsertDriveFileOutlined,
  LinkOutlined,
  OpenInNew,
  PictureAsPdfOutlined,
  Public,
  Search,
  VideoFileOutlined,
  ViewListOutlined,
  ImageOutlined,
  AudioFileOutlined
} from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { DriveFile, DriveFolder, UploadJob } from '@shared/types/google'
import { formatBytes } from '@shared/utils/recorder'
import { ConnectDriveCard, DriveAccountBar } from '../google/ConnectDrive'
import FolderTree, { folderPath, useDriveFolders } from '../google/FolderTree'
import { useGoogle } from '../google/useGoogle'

const fs = () => window.printAgent.fileShare

const thumbCache = new Map<string, string | null>()

const iconFor = (mime: string) =>
  mime.startsWith('image/') ? <ImageOutlined /> : mime.startsWith('video/') ? <VideoFileOutlined /> : mime.startsWith('audio/') ? <AudioFileOutlined /> : mime === 'application/pdf' ? <PictureAsPdfOutlined /> : <InsertDriveFileOutlined />

const when = (ms: number): string => {
  if (!ms) return ''
  const d = new Date(ms)
  const today = new Date()
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Drive's preview image, fetched once through the main process. */
const Thumb = ({ file, size, height }: { file: DriveFile; size: number; height: number }) => {
  const key = `${file.id}:${size}`
  const [src, setSrc] = useState<string | null | undefined>(() => thumbCache.get(key))
  useEffect(() => {
    if (!file.hasThumb || thumbCache.has(key)) return
    let active = true
    void fs()
      .thumbnail(file.id, size)
      .then(r => {
        const value = r.ok ? r.value : null
        thumbCache.set(key, value)
        if (active) setSrc(value)
      })
    return () => {
      active = false
    }
  }, [file.id, file.hasThumb, key, size])
  return (
    <Box sx={{ height, display: 'grid', placeItems: 'center', bgcolor: 'action.hover', color: 'text.secondary', backgroundImage: src ? `url("${src}")` : undefined, backgroundSize: 'cover', backgroundPosition: 'center' }}>
      {!src && (file.hasThumb && src === undefined ? <CircularProgress size={18} /> : iconFor(file.mime))}
    </Box>
  )
}

/** File Share: the user's own Google Drive — pick a folder, upload, share a public link. */
const FileSharePage = () => {
  const google = useGoogle()
  const connected = !!google.status?.account
  const folders = useDriveFolders(connected)
  const [folderId, setFolderId] = useState<string>('')
  const [files, setFiles] = useState<DriveFile[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<UploadJob[]>([])
  const [view, setView] = useState<'list' | 'grid'>('grid')
  const [query, setQuery] = useState('')
  const [note, setNote] = useState('')
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<DriveFile | null>(null)
  const [editing, setEditing] = useState<{ file: DriveFile; text: string } | null>(null)
  const [deleting, setDeleting] = useState<DriveFile | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Which folder to show: the one used last time.
  useEffect(() => {
    if (!connected) return
    void fs()
      .getFolder()
      .then(r => {
        if (r.ok) setFolderId(r.value)
      })
  }, [connected, google.status?.account?.email])

  const load = useCallback((id: string) => {
    if (!id) return Promise.resolve()
    return fs()
      .list(id)
      .then(r => {
        if (r.ok) {
          setFiles(r.value)
          setListError(null)
        } else setListError(r.error)
      })
  }, [])

  useEffect(() => {
    if (!folderId || !connected) return
    void fs()
      .list(folderId)
      .then(r => {
        if (r.ok) {
          setFiles(r.value)
          setListError(null)
        } else setListError(r.error)
      })
  }, [folderId, connected])

  useEffect(() => {
    void fs()
      .jobs()
      .then(r => r.ok && setJobs(r.value))
    const offJob = fs().onJob(job => {
      setJobs(list => (list.some(j => j.id === job.id) ? list.map(j => (j.id === job.id ? job : j)) : [job, ...list]))
      if (job.status === 'failed') toast.error(`${job.name}: ${job.error ?? 'upload failed'}`, { duration: 8000 })
    })
    const offFiles = fs().onFilesChanged(id => {
      if (id === folderId) void load(id)
    })
    return () => {
      offJob()
      offFiles()
    }
  }, [folderId, load])

  const choose = (folder: DriveFolder) => {
    setFolderId(folder.id)
    setFiles(null)
    void fs().setFolder(folder.id)
  }

  const upload = async (call: Promise<{ ok: boolean; error?: string }>) => {
    const r = await call
    if (!r.ok) toast.error(r.error ?? 'Upload failed')
    else setNote('')
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (!folderId) return
    const dropped = Array.from(e.dataTransfer.files)
    const paths = dropped.map(f => fs().pathForFile(f)).filter(Boolean)
    if (paths.length) void upload(fs().uploadPaths(paths, folderId, note))
    else if (dropped.length) toast.error('Drop files from your computer (not folders).')
  }

  // Paste an image (e.g. a screenshot) to upload it.
  useEffect(() => {
    if (!connected || !folderId) return
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const items = Array.from(e.clipboardData?.files ?? [])
      if (!items.length) return
      e.preventDefault()
      for (const file of items) {
        void file.arrayBuffer().then(buffer => {
          const ext = file.type.split('/')[1] ?? 'png'
          const name = file.name && file.name !== 'image.png' ? file.name : `Pasted ${new Date().toLocaleString().replace(/[/:,]/g, '-')}.${ext}`
          void upload(fs().uploadBytes(name, file.type, new Uint8Array(buffer), folderId, note))
        })
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [connected, folderId, note])

  const act = async (id: string, run: () => Promise<void>) => {
    setBusy(id)
    try {
      await run()
    } finally {
      setBusy(null)
    }
  }

  const copyLink = (file: DriveFile) =>
    act(`link:${file.id}`, async () => {
      const r = await fs().share(file.id)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      await navigator.clipboard.writeText(r.value)
      toast.success('Public link copied — anyone with it can view')
      setFiles(list => list?.map(f => (f.id === file.id ? { ...f, shared: true, link: r.value } : f)) ?? null)
    })

  const download = (file: DriveFile) =>
    act(`dl:${file.id}`, async () => {
      const r = await fs().download(file.id, file.name)
      if (!r.ok) toast.error(r.error)
      else if (r.value) toast.success('Downloaded')
    })

  const saveDescription = async () => {
    if (!editing) return
    const r = await fs().describe(editing.file.id, editing.text)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    setFiles(list => list?.map(f => (f.id === editing.file.id ? { ...f, description: r.value } : f)) ?? null)
    setEditing(null)
  }

  const remove = async () => {
    if (!deleting) return
    const file = deleting
    setDeleting(null)
    await act(`rm:${file.id}`, async () => {
      const r = await fs().remove(file.id)
      if (!r.ok) toast.error(r.error)
      else {
        toast.success('Moved to Drive trash')
        setFiles(list => list?.filter(f => f.id !== file.id) ?? null)
      }
    })
  }

  const shown = useMemo(() => {
    const term = query.trim().toLowerCase()
    return (files ?? []).filter(f => !term || f.name.toLowerCase().includes(term) || f.description.toLowerCase().includes(term))
  }, [files, query])

  const activeJobs = jobs.filter(j => j.folderId === folderId && j.status !== 'done')
  const path = folders.tree ? folderPath(folders.tree, folderId) : null

  if (!google.status) {
    return (
      <Stack alignItems='center' sx={{ py: 10 }}>
        <CircularProgress size={28} />
      </Stack>
    )
  }

  const actions = (f: DriveFile) => (
    <Stack direction='row' spacing={0.25}>
      <Tooltip title={f.shared ? 'Copy public link' : 'Make public & copy link'}>
        <IconButton size='small' onClick={() => void copyLink(f)} disabled={busy === `link:${f.id}`}>
          {busy === `link:${f.id}` ? <CircularProgress size={16} /> : <LinkOutlined fontSize='small' />}
        </IconButton>
      </Tooltip>
      <Tooltip title='Open in Google Drive'>
        <IconButton size='small' onClick={() => void fs().openLink(f.link)}>
          <OpenInNew fontSize='small' />
        </IconButton>
      </Tooltip>
      <Tooltip title='Download'>
        <IconButton size='small' onClick={() => void download(f)} disabled={busy === `dl:${f.id}`}>
          {busy === `dl:${f.id}` ? <CircularProgress size={16} /> : <DownloadOutlined fontSize='small' />}
        </IconButton>
      </Tooltip>
      <Tooltip title='Description'>
        <IconButton size='small' onClick={() => setEditing({ file: f, text: f.description })}>
          <EditNoteOutlined fontSize='small' />
        </IconButton>
      </Tooltip>
      <Tooltip title='Delete'>
        <IconButton size='small' onClick={() => setDeleting(f)} disabled={busy === `rm:${f.id}`}>
          <DeleteOutline fontSize='small' />
        </IconButton>
      </Tooltip>
    </Stack>
  )

  return (
    <Stack spacing={4} sx={{ maxWidth: 1200, mx: 'auto' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ md: 'flex-end' }} spacing={2}>
        <Box sx={{ flex: 1 }}>
          <Typography variant='h4' sx={{ fontSize: 24, fontWeight: 700 }}>
            File Share
          </Typography>
          <Typography color='text.secondary' sx={{ fontSize: 14, mt: 0.5 }}>
            Upload to your own Google Drive and share a public link. Drop files anywhere on this page, or paste an image.
          </Typography>
        </Box>
        {connected && <DriveAccountBar status={google.status} onDisconnect={() => void google.disconnect()} onSwitch={() => void google.connect()} />}
      </Stack>

      {!connected ? (
        <ConnectDriveCard status={google.status} onConnect={() => void google.connect()} onCancel={google.cancel} purpose='File Share needs access to your Google Drive before you can share files.' />
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '280px 1fr' }, gap: 3, alignItems: 'start' }}>
          <Paper variant='outlined' sx={{ p: 2, borderRadius: 3, position: { md: 'sticky' }, top: 0 }}>
            <FolderTree tree={folders.tree} error={folders.error} selected={folderId} onSelect={choose} onRefresh={() => void folders.refresh()} />
          </Paper>

          <Paper
            variant='outlined'
            onDragOver={e => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={e => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
            }}
            onDrop={onDrop}
            sx={{ p: 3, borderRadius: 3, position: 'relative', minHeight: 420, outline: dragging ? '2px dashed' : 'none', outlineColor: 'primary.main', outlineOffset: -6 }}
          >
            <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} alignItems={{ lg: 'center' }} sx={{ mb: 2 }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography noWrap sx={{ fontWeight: 600, fontSize: 16 }} title={path ?? ''}>
                  {path ?? 'Folder'}
                </Typography>
                <Typography variant='caption' color='text.secondary'>
                  {files ? `${files.length} file${files.length === 1 ? '' : 's'}` : ' '}
                </Typography>
              </Box>
              <TextField
                size='small'
                placeholder='Search'
                value={query}
                onChange={e => setQuery(e.target.value)}
                slotProps={{ input: { startAdornment: <InputAdornment position='start'><Search fontSize='small' /></InputAdornment> } }}
                sx={{ width: { lg: 200 } }}
              />
              <ToggleButtonGroup size='small' exclusive value={view} onChange={(_e, v: 'list' | 'grid' | null) => v && setView(v)}>
                <ToggleButton value='grid' aria-label='Gallery view'>
                  <GridViewOutlined fontSize='small' />
                </ToggleButton>
                <ToggleButton value='list' aria-label='List view'>
                  <ViewListOutlined fontSize='small' />
                </ToggleButton>
              </ToggleButtonGroup>
              <Button variant='contained' startIcon={<CloudUploadOutlined />} disabled={!folderId} onClick={() => void upload(fs().chooseAndUpload(folderId, note))}>
                Upload files
              </Button>
            </Stack>
            <TextField
              size='small'
              fullWidth
              placeholder='Description for the next upload (optional) — shows in Google Drive'
              value={note}
              onChange={e => setNote(e.target.value)}
              sx={{ mb: 2 }}
            />

            {activeJobs.length > 0 && (
              <Stack spacing={1} sx={{ mb: 2 }}>
                {activeJobs.map(job => (
                  <Paper key={job.id} variant='outlined' sx={{ p: 1.5, borderRadius: 2 }}>
                    <Stack direction='row' alignItems='center' spacing={1.5}>
                      <Typography noWrap sx={{ flex: 1, fontSize: 13 }}>
                        {job.name}
                      </Typography>
                      <Typography sx={{ fontSize: 12, color: job.status === 'failed' ? 'error.main' : 'text.secondary' }}>
                        {job.status === 'uploading' ? `${formatBytes(job.sent)} / ${formatBytes(job.size)}` : job.status === 'failed' ? 'Failed' : 'Cancelled'}
                      </Typography>
                      {job.status === 'uploading' ? (
                        <IconButton size='small' onClick={() => void fs().cancelUpload(job.id)} aria-label='Cancel upload'>
                          <Close fontSize='small' />
                        </IconButton>
                      ) : (
                        <IconButton size='small' onClick={() => setJobs(list => list.filter(j => j.id !== job.id))} aria-label='Dismiss'>
                          <Close fontSize='small' />
                        </IconButton>
                      )}
                    </Stack>
                    {job.status === 'uploading' && <LinearProgress variant='determinate' value={job.size ? (job.sent / job.size) * 100 : 0} sx={{ mt: 1, borderRadius: 1 }} />}
                    {job.error && (
                      <Typography sx={{ fontSize: 12, color: 'error.main', mt: 0.5 }}>
                        {job.error}
                      </Typography>
                    )}
                  </Paper>
                ))}
              </Stack>
            )}

            {listError && <Alert severity='error'>{listError}</Alert>}
            {!files && !listError && (
              <Stack alignItems='center' sx={{ py: 8 }}>
                <CircularProgress size={24} />
              </Stack>
            )}
            {files && !shown.length && (
              <Stack alignItems='center' spacing={1} sx={{ py: 8, color: 'text.secondary' }}>
                <CloudUploadOutlined sx={{ fontSize: 40, opacity: 0.6 }} />
                <Typography>{files.length ? 'No files match.' : 'No files here yet. Drop files, paste an image, or click Upload files.'}</Typography>
              </Stack>
            )}

            {view === 'grid' ? (
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 2 }}>
                {shown.map(f => (
                  <Paper key={f.id} variant='outlined' sx={{ borderRadius: 2, overflow: 'hidden' }}>
                    <ButtonBase sx={{ display: 'block', width: '100%' }} onClick={() => (f.mime.startsWith('image/') ? setPreview(f) : void fs().openLink(f.link))}>
                      <Thumb file={f} size={400} height={120} />
                    </ButtonBase>
                    <Box sx={{ px: 1.5, pt: 1 }}>
                      <Stack direction='row' spacing={0.5} alignItems='center'>
                        <Typography noWrap sx={{ fontSize: 13, fontWeight: 500, flex: 1 }} title={f.name}>
                          {f.name}
                        </Typography>
                        {f.shared && (
                          <Tooltip title='Public link'>
                            <Public sx={{ fontSize: 15, color: 'success.main' }} />
                          </Tooltip>
                        )}
                      </Stack>
                      <Typography noWrap sx={{ fontSize: 11.5, color: 'text.secondary' }} title={f.description}>
                        {f.description || `${formatBytes(f.size)} · ${when(f.createdAt)}`}
                      </Typography>
                    </Box>
                    <Box sx={{ px: 0.5, pb: 0.5 }}>{actions(f)}</Box>
                  </Paper>
                ))}
              </Box>
            ) : (
              <Stack divider={<Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }} />}>
                {shown.map(f => (
                  <Stack key={f.id} direction='row' alignItems='center' spacing={2} sx={{ py: 1 }}>
                    <ButtonBase onClick={() => (f.mime.startsWith('image/') ? setPreview(f) : void fs().openLink(f.link))} sx={{ width: 56, borderRadius: 1, overflow: 'hidden', flexShrink: 0 }}>
                      <Box sx={{ width: 56 }}>
                        <Thumb file={f} size={120} height={40} />
                      </Box>
                    </ButtonBase>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction='row' spacing={1} alignItems='center'>
                        <Typography noWrap sx={{ fontSize: 13.5, fontWeight: 500 }}>
                          {f.name}
                        </Typography>
                        {f.shared && <Chip size='small' color='success' variant='outlined' icon={<Public />} label='Public' sx={{ height: 20, fontSize: 11 }} />}
                      </Stack>
                      <Typography noWrap sx={{ fontSize: 12, color: 'text.secondary' }}>
                        {formatBytes(f.size)} · {when(f.createdAt)}
                        {f.description ? ` · ${f.description}` : ''}
                      </Typography>
                    </Box>
                    {actions(f)}
                  </Stack>
                ))}
              </Stack>
            )}

            {dragging && (
              <Stack alignItems='center' justifyContent='center' sx={{ position: 'absolute', inset: 0, borderRadius: 3, bgcolor: 'rgb(var(--mui-palette-primary-mainChannel) / 0.08)', pointerEvents: 'none' }}>
                <CloudUploadOutlined sx={{ fontSize: 48, color: 'primary.main' }} />
                <Typography sx={{ fontWeight: 600, color: 'primary.main' }}>Drop to upload to {path ?? 'this folder'}</Typography>
              </Stack>
            )}
          </Paper>
        </Box>
      )}

      <Dialog open={!!preview} onClose={() => setPreview(null)} maxWidth='lg'>
        {preview && (
          <>
            <DialogTitle sx={{ pr: 6 }}>
              {preview.name}
              <IconButton onClick={() => setPreview(null)} sx={{ position: 'absolute', right: 12, top: 12 }} aria-label='Close'>
                <Close />
              </IconButton>
            </DialogTitle>
            <DialogContent>
              <Box sx={{ width: { xs: '80vw', md: 900 }, maxWidth: '100%' }}>
                <Thumb file={preview} size={1600} height={560} />
              </Box>
              {preview.description && <Typography sx={{ mt: 2 }}>{preview.description}</Typography>}
            </DialogContent>
            <DialogActions>
              <Button startIcon={<LinkOutlined />} onClick={() => void copyLink(preview)}>
                Copy public link
              </Button>
              <Button startIcon={<DownloadOutlined />} onClick={() => void download(preview)}>
                Download
              </Button>
              <Button startIcon={<OpenInNew />} onClick={() => void fs().openLink(preview.link)}>
                Open in Drive
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <Dialog open={!!editing} onClose={() => setEditing(null)} fullWidth maxWidth='sm'>
        <DialogTitle>Description</DialogTitle>
        <DialogContent>
          <TextField autoFocus fullWidth multiline minRows={3} placeholder='Visible in Google Drive’s file details' value={editing?.text ?? ''} onChange={e => editing && setEditing({ ...editing, text: e.target.value })} sx={{ mt: 1 }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(null)}>Cancel</Button>
          <Button variant='contained' onClick={() => void saveDescription()}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!deleting} onClose={() => setDeleting(null)}>
        <DialogTitle>Delete “{deleting?.name}”?</DialogTitle>
        <DialogContent>
          <Typography>It moves to your Google Drive trash, where you can restore it for 30 days. Its public link stops working.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button color='error' variant='contained' onClick={() => void remove()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}

export default FileSharePage
