import { useCallback, useEffect, useState } from 'react'
import { Box, ButtonBase, CircularProgress, IconButton, Stack, TextField, Tooltip, Typography } from '@mui/material'
import { Add, ChevronRight, ExpandMore, Folder, FolderOpen, Refresh } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { DriveFolder } from '@shared/types/google'

/** The Drive folders the app can use, loaded from the main process. */
export const useDriveFolders = (enabled: boolean): { tree: DriveFolder[] | null; error: string | null; refresh: () => Promise<void> } => {
  const [tree, setTree] = useState<DriveFolder[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(
    () =>
      window.printAgent.google.folders().then(r => {
        if (r.ok) {
          setTree(r.value)
          setError(null)
        } else setError(r.error)
      }),
    []
  )
  useEffect(() => {
    if (!enabled) return
    void window.printAgent.google.folders().then(r => {
      if (r.ok) {
        setTree(r.value)
        setError(null)
      } else setError(r.error)
    })
  }, [enabled])
  return { tree, error, refresh }
}

export const findFolder = (nodes: DriveFolder[], id: string): DriveFolder | null => {
  for (const node of nodes) {
    if (node.id === id) return node
    const inner = findFolder(node.children, id)
    if (inner) return inner
  }
  return null
}

/** Path of names from a root to `id`, e.g. "Featured App / Screenshots". */
export const folderPath = (nodes: DriveFolder[], id: string, trail: string[] = []): string | null => {
  for (const node of nodes) {
    const here = [...trail, node.name]
    if (node.id === id) return here.join(' / ')
    const inner = folderPath(node.children, id, here)
    if (inner) return inner
  }
  return null
}

const contains = (node: DriveFolder, id: string): boolean => node.id === id || node.children.some(c => contains(c, id))

const Node = ({ node, depth, selected, onSelect, onCreated }: { node: DriveFolder; depth: number; selected: string; onSelect: (folder: DriveFolder) => void; onCreated: () => void }) => {
  const [open, setOpen] = useState(() => !!node.root || contains(node, selected))
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const active = node.id === selected

  const create = async () => {
    if (!name.trim()) {
      setAdding(false)
      return
    }
    setBusy(true)
    const r = await window.printAgent.google.createFolder(name.trim(), node.id)
    setBusy(false)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    setAdding(false)
    setName('')
    setOpen(true)
    onCreated()
    onSelect({ id: r.value.id, name: r.value.name, children: [] })
  }

  return (
    <Box>
      <Stack
        direction='row'
        alignItems='center'
        sx={{
          pl: depth * 1.75,
          pr: 0.5,
          borderRadius: 1.5,
          bgcolor: active ? 'var(--mui-palette-primary-lightOpacity)' : 'transparent',
          '&:hover': { bgcolor: active ? 'var(--mui-palette-primary-lightOpacity)' : 'action.hover' },
          '&:hover .add': { opacity: 1 }
        }}
      >
        <IconButton size='small' onClick={() => setOpen(!open)} sx={{ visibility: node.children.length ? 'visible' : 'hidden', p: 0.25 }} aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}>
          {open ? <ExpandMore sx={{ fontSize: 18 }} /> : <ChevronRight sx={{ fontSize: 18 }} />}
        </IconButton>
        <ButtonBase onClick={() => onSelect(node)} sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', gap: 1, py: 0.75, px: 0.5, borderRadius: 1 }}>
          {active ? <FolderOpen sx={{ fontSize: 18, color: 'primary.main' }} /> : <Folder sx={{ fontSize: 18, color: 'text.secondary' }} />}
          <Typography noWrap sx={{ fontSize: 13.5, fontWeight: active ? 600 : 400, color: active ? 'primary.main' : 'text.primary' }}>
            {node.name}
          </Typography>
        </ButtonBase>
        <Tooltip title='New subfolder'>
          <IconButton className='add' size='small' onClick={() => setAdding(true)} sx={{ opacity: 0, p: 0.25 }} aria-label={`New folder in ${node.name}`}>
            <Add sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Stack>
      {adding && (
        <Stack direction='row' spacing={1} alignItems='center' sx={{ pl: depth * 1.75 + 4, pr: 1, py: 0.5 }}>
          <TextField
            size='small'
            autoFocus
            placeholder='Folder name'
            value={name}
            disabled={busy}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void create()
              if (e.key === 'Escape') setAdding(false)
            }}
            onBlur={() => !name.trim() && setAdding(false)}
            sx={{ flex: 1, '& input': { fontSize: 13, py: 0.75 } }}
          />
          {busy && <CircularProgress size={16} />}
        </Stack>
      )}
      {open && node.children.map(child => <Node key={child.id} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} onCreated={onCreated} />)}
    </Box>
  )
}

/** Drive folders as a tree: click to choose, + to make a subfolder. */
const FolderTree = ({ tree, error, selected, onSelect, onRefresh }: { tree: DriveFolder[] | null; error: string | null; selected: string; onSelect: (folder: DriveFolder) => void; onRefresh: () => void }) => (
  <Box>
    <Stack direction='row' alignItems='center' sx={{ mb: 1 }}>
      <Typography sx={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.6 }}>My Drive</Typography>
      <Tooltip title='Refresh folders'>
        <IconButton size='small' onClick={onRefresh} aria-label='Refresh folders'>
          <Refresh sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    </Stack>
    {!tree && !error && (
      <Stack alignItems='center' sx={{ py: 3 }}>
        <CircularProgress size={20} />
      </Stack>
    )}
    {error && (
      <Typography color='error' sx={{ fontSize: 13 }}>
        {error}
      </Typography>
    )}
    {tree?.map(root => <Node key={root.id} node={root} depth={0} selected={selected} onSelect={onSelect} onCreated={onRefresh} />)}
    {tree && (
      <Typography variant='caption' color='text.secondary' component='div' sx={{ mt: 1.5, lineHeight: 1.4 }}>
        Shows the folders made by this app (and share-chat) in your Drive. Folders you made in Drive yourself do not appear — use + to add a subfolder here.
      </Typography>
    )}
  </Box>
)

export default FolderTree
