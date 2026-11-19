import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { Alert, Box, Button, Chip, Paper, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { CloudUploadOutlined, SubtitlesOutlined } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { TranscriptJob, TranscriptLanguage, TranscriptModel, TranscriptModelInfo } from '@shared/types/transcriber'
import { isMediaFile, modelSupports, TRANSCRIPT_LANGUAGES } from '@shared/utils/transcriber'
import TranscriptCard from './TranscriptCard'

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Upload a video or audio file, pick the spoken language, get the text. */
const TranscriptPage = () => {
  const api = window.printAgent.transcriber
  const [files, setFiles] = useState<string[]>([])
  const [language, setLanguage] = useState<TranscriptLanguage>('en')
  const [model, setModel] = useState<TranscriptModel>('accurate')
  const [jobs, setJobs] = useState<TranscriptJob[]>([])
  const [models, setModels] = useState<TranscriptModelInfo[]>([])
  const [dragging, setDragging] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = useCallback(
    () =>
      Promise.all([api.list(), api.models()]).then(([list, info]) => {
        if (list.ok) setJobs(list.value)
        if (info.ok) setModels(info.value)
      }),
    [api]
  )

  useEffect(() => {
    void Promise.resolve().then(refresh)
    const offList = api.onListChanged(() => void refresh())
    const offJob = api.onJob(job => {
      setJobs(prev => prev.map(j => (j.id === job.id ? job : j)))
      if (job.status === 'done') {
        toast.success(`Transcript ready: ${job.fileName}`, { id: `transcript-${job.id}` })
        void api.models().then(r => r.ok && setModels(r.value))
      } else if (job.status === 'failed' && job.error) toast.error(job.error, { id: `transcript-${job.id}`, duration: 8000 })
    })
    return () => {
      offList()
      offJob()
    }
  }, [api, refresh])

  const addFiles = (paths: string[]) => {
    const media = paths.filter(Boolean).filter(isMediaFile)
    if (media.length < paths.length) toast.error('Only video or audio files can be transcribed.')
    setFiles(prev => [...new Set([...prev, ...media])])
  }

  const choose = async () => {
    const result = await api.chooseFiles()
    if (result.ok) addFiles(result.value)
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    addFiles([...event.dataTransfer.files].map(f => api.pathForFile(f)))
  }

  const pickLanguage = (value: TranscriptLanguage | null) => {
    if (!value) return
    setLanguage(value)
    if (!modelSupports(model, value)) setModel('accurate')
  }

  const start = async () => {
    setError(null)
    setStarting(true)
    try {
      const result = await api.start(files, language, model)
      if (!result.ok) throw new Error(result.error)
      setFiles([])
      setExpanded(result.value[0]?.id ?? null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const info = models.find(m => m.model === model)

  return (
    <Stack spacing={4} sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Box>
        <Typography variant='h4' sx={{ fontSize: 24, fontWeight: 700 }}>
          Transcripts
        </Typography>
        <Typography color='text.secondary' sx={{ fontSize: 14, mt: 0.5 }}>
          Upload a video or audio file and turn its speech into text, in English or Hindi. Everything runs on this computer.
        </Typography>
      </Box>

      <Paper variant='outlined' sx={{ p: 4, borderRadius: 3 }}>
        <Box
          onDragOver={e => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          sx={{
            border: '2px dashed',
            borderColor: dragging ? 'primary.main' : 'divider',
            bgcolor: dragging ? 'var(--mui-palette-primary-lighterOpacity)' : 'transparent',
            borderRadius: 3,
            p: 5,
            textAlign: 'center',
            transition: 'all .15s'
          }}
        >
          <Box sx={{ width: 56, height: 56, mx: 'auto', mb: 2, borderRadius: '50%', display: 'grid', placeItems: 'center', color: 'primary.main', bgcolor: 'var(--mui-palette-primary-lightOpacity)' }}>
            <CloudUploadOutlined sx={{ fontSize: 30 }} />
          </Box>
          <Typography sx={{ fontWeight: 600, fontSize: 16 }}>Drop a video or audio file here</Typography>
          <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
            MP4, MOV, MKV, WEBM, MP3, WAV, M4A and more
          </Typography>
          <Button variant='outlined' onClick={() => void choose()}>
            Choose files
          </Button>
        </Box>

        {files.length > 0 && (
          <Stack direction='row' sx={{ flexWrap: 'wrap', gap: 1, mt: 3 }}>
            {files.map(f => (
              <Chip key={f} label={fileName(f)} title={f} onDelete={() => setFiles(prev => prev.filter(p => p !== f))} />
            ))}
          </Stack>
        )}

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 3, mt: 4 }}>
          <Box>
            <Typography variant='body2' sx={{ fontWeight: 600, mb: 1 }}>
              Language spoken in the file
            </Typography>
            <ToggleButtonGroup exclusive fullWidth size='small' color='primary' value={language} onChange={(_e, v: TranscriptLanguage | null) => pickLanguage(v)}>
              {TRANSCRIPT_LANGUAGES.map(l => (
                <ToggleButton key={l.value} value={l.value}>
                  {l.value === 'hi' ? 'Hindi (हिन्दी)' : l.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>
          <Box>
            <Typography variant='body2' sx={{ fontWeight: 600, mb: 1 }}>
              Quality
            </Typography>
            <ToggleButtonGroup exclusive fullWidth size='small' color='primary' value={model} onChange={(_e, v: TranscriptModel | null) => v && setModel(v)}>
              <ToggleButton value='accurate'>High accuracy</ToggleButton>
              <ToggleButton value='fast' disabled={!modelSupports('fast', language)}>
                Fast (English only)
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>
        </Box>

        {info && !info.downloaded && (
          <Alert severity='info' sx={{ mt: 3 }}>
            The first transcript with this quality downloads the speech model (about {info.sizeMb} MB). After that it works offline.
          </Alert>
        )}
        {error && (
          <Alert severity='error' sx={{ mt: 3 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Stack direction='row' justifyContent='flex-end' sx={{ mt: 3 }}>
          <Button variant='contained' size='large' disabled={!files.length || starting} startIcon={<SubtitlesOutlined />} onClick={() => void start()}>
            {files.length > 1 ? `Transcribe ${files.length} files` : 'Transcribe'}
          </Button>
        </Stack>
      </Paper>

      <Box>
        <Typography variant='h6' sx={{ fontSize: 16, fontWeight: 600, mb: 2 }}>
          Your transcripts
        </Typography>
        {jobs.length === 0 ? (
          <Paper variant='outlined' sx={{ p: 5, borderRadius: 3, textAlign: 'center' }}>
            <Typography color='text.secondary'>No transcripts yet. Upload a file above to start.</Typography>
          </Paper>
        ) : (
          <Stack spacing={2}>
            {jobs.map(job => (
              <TranscriptCard key={job.id} job={job} expanded={expanded === job.id} onToggle={() => setExpanded(e => (e === job.id ? null : job.id))} />
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  )
}

export default TranscriptPage
