import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, ButtonBase, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { Close, ErrorOutline } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { HotkeyStatus, ScreenshotAction, ScreenshotEnvironment, ScreenshotSettings } from '@shared/types/screenshot'
import { ACTION_LABEL, acceleratorFromKeys, formatAccelerator, SCREENSHOT_ACTIONS } from '@shared/utils/screenshot'
import { Row, Section } from './ui'

/** A field that records the next key combination pressed while it has focus. */
const ShortcutField = ({ value, mac, status, onChange }: { value: string; mac: boolean; status: HotkeyStatus | undefined; onChange: (accelerator: string) => void }) => {
  const api = window.printAgent.screenshot
  const [recording, setRecording] = useState(false)
  const [held, setHeld] = useState('')
  const ref = useRef<HTMLButtonElement | null>(null)
  const changed = useRef(onChange)
  useEffect(() => {
    changed.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!recording) return
    // While recording, the shortcuts themselves must not fire.
    void api.suspendHotkeys(true)
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        ref.current?.blur()
        return
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        changed.current('')
        ref.current?.blur()
        return
      }
      const accelerator = acceleratorFromKeys(e, mac)
      if (accelerator) {
        changed.current(accelerator)
        ref.current?.blur()
        return
      }
      // Show the modifiers held so far.
      setHeld(formatAccelerator([e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command', '…'].filter(Boolean).join('+'), mac))
    }
    const onUp = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) setHeld('')
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onUp, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onUp, true)
      void api.suspendHotkeys(false)
    }
  }, [recording, mac, api])

  const taken = !!value && status && !status.registered && !recording
  return (
    <Stack direction='row' alignItems='center' spacing={1}>
      {taken && (
        <Tooltip title='Another app or the system already uses this shortcut. Choose another one, or free it in the system keyboard settings.'>
          <ErrorOutline color='warning' fontSize='small' />
        </Tooltip>
      )}
      <ButtonBase
        ref={ref}
        onFocus={() => setRecording(true)}
        onBlur={() => {
          setRecording(false)
          setHeld('')
        }}
        sx={{
          width: 200,
          height: 34,
          borderRadius: 999,
          border: '1.5px solid',
          borderColor: recording ? 'primary.main' : taken ? 'warning.main' : 'divider',
          bgcolor: recording ? 'var(--mui-palette-primary-lighterOpacity)' : 'action.hover',
          fontSize: 14,
          fontWeight: value ? 600 : 400,
          color: value || recording ? 'text.primary' : 'text.secondary',
          letterSpacing: mac ? 1 : 0,
          position: 'relative'
        }}
      >
        {recording ? held || 'Type shortcut…' : value ? formatAccelerator(value, mac) : 'Record Shortcut'}
      </ButtonBase>
      <Box sx={{ width: 30 }}>
        {value && !recording && (
          <IconButton size='small' onClick={() => onChange('')} aria-label='Clear shortcut'>
            <Close fontSize='small' />
          </IconButton>
        )}
      </Box>
    </Stack>
  )
}

const HotkeysTab = ({ settings, env, onUpdate }: { settings: ScreenshotSettings; env: ScreenshotEnvironment; onUpdate: (patch: Partial<ScreenshotSettings>) => void }) => {
  const mac = env.platform === 'darwin'
  const set = (action: ScreenshotAction, accelerator: string) => {
    const clash = accelerator ? SCREENSHOT_ACTIONS.find(a => a !== action && settings.hotkeys[a] === accelerator) : undefined
    if (clash) {
      toast.error(`${formatAccelerator(accelerator, mac)} is already used for “${ACTION_LABEL[clash]}”.`)
      return
    }
    onUpdate({ hotkeys: { ...settings.hotkeys, [action]: accelerator } })
  }
  const statusOf = (action: ScreenshotAction) => env.hotkeys.find(h => h.action === action)
  const anyTaken = env.hotkeys.some(h => h.accelerator && !h.registered)

  return (
    <Stack spacing={4}>
      {mac && (
        <Section title='Use ⇧⌘3 and ⇧⌘4 for Featured App' subtitle='macOS keeps its own screenshot shortcuts until you turn them off.'>
          <Stack spacing={1.5} sx={{ py: 1.5 }}>
            <Typography variant='body2'>1. Open System Settings → Keyboard → Keyboard Shortcuts.</Typography>
            <Box>
              <Button size='small' variant='outlined' onClick={() => void window.printAgent.screenshot.openKeyboardSettings()}>
                Open System Settings
              </Button>
            </Box>
            <Typography variant='body2'>2. Select “Screenshots” and uncheck the system shortcuts.</Typography>
            <Typography variant='body2'>3. Put ⇧⌘3 into Fullscreen and ⇧⌘4 into Area below.</Typography>
          </Stack>
        </Section>
      )}

      {anyTaken && <Alert severity='warning'>A shortcut marked with ⚠ is already used by another app or the system, so it does nothing here. Pick a different one.</Alert>}

      <Section title='Shortcuts' subtitle='Work everywhere, even with the app window closed. Click a field and press the keys; Backspace clears it.'>
        {SCREENSHOT_ACTIONS.map(action => (
          <Row key={action} title={ACTION_LABEL[action]} hint={action === 'window' ? (mac ? 'Hover a window and click it.' : 'Pick from a list of open windows.') : action === 'activeWindow' ? 'The window you are working in.' : action === 'repeatArea' ? 'Captures the same area as last time, without selecting.' : undefined}>
            <ShortcutField value={settings.hotkeys[action]} mac={mac} status={statusOf(action)} onChange={accelerator => set(action, accelerator)} />
          </Row>
        ))}
      </Section>
    </Stack>
  )
}

export default HotkeysTab
