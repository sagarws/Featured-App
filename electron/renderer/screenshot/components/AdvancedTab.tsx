import { Checkbox, FormControlLabel, Stack } from '@mui/material'
import type { ScreenshotEnvironment, ScreenshotSettings } from '@shared/types/screenshot'
import { Choice, Row, Section } from './ui'

const AdvancedTab = ({ settings, env, onUpdate }: { settings: ScreenshotSettings; env: ScreenshotEnvironment; onUpdate: (patch: Partial<ScreenshotSettings>) => void }) => {
  const mac = env.platform === 'darwin'
  return (
    <Stack spacing={4}>
      <Section title='Menu bar & windows'>
        <Row
          title={mac ? 'Menu bar icon' : 'Tray icon'}
          hint={`Screenshots one click away in the ${mac ? 'menu bar' : 'notification area'}. Hidden, shortcuts still work; open the app by launching it again.`}
        >
          <FormControlLabel control={<Checkbox size='small' checked={settings.hideTrayIcon} onChange={e => onUpdate({ hideTrayIcon: e.target.checked })} />} label={mac ? 'Hide menu bar icon' : 'Hide tray icon'} sx={{ mr: 0 }} />
        </Row>
        <Row title='Editor window'>
          <FormControlLabel control={<Checkbox size='small' checked={settings.editorAlwaysOnTop} onChange={e => onUpdate({ editorAlwaysOnTop: e.target.checked })} />} label='Always on top' sx={{ mr: 0 }} />
        </Row>
        <Row title='Default zoom level' hint='Open at actual size when the screenshot fits on screen, else fit it to the window.'>
          <FormControlLabel control={<Checkbox size='small' checked={settings.preferActualSize} onChange={e => onUpdate({ preferActualSize: e.target.checked })} />} label='Prefer 100%' sx={{ mr: 0 }} />
        </Row>
        <Row title='Action when closing with Esc' hint='What happens to the edited screenshot when you press Esc in the editor.'>
          <FormControlLabel control={<Checkbox size='small' checked={settings.escCopy} onChange={e => onUpdate({ escCopy: e.target.checked })} />} label='Copy image' />
          <FormControlLabel control={<Checkbox size='small' checked={settings.escSave} onChange={e => onUpdate({ escSave: e.target.checked })} />} label='Save image' sx={{ mr: 0 }} />
        </Row>
        <Row title='Confirmation style' hint='How you are told a screenshot was copied, saved or uploaded when no editor is open. Errors always show.'>
          <Choice
            value={settings.confirmation}
            options={[
              { value: 'notification', label: 'Notification' },
              { value: 'none', label: 'None' }
            ]}
            onChange={confirmation => onUpdate({ confirmation })}
          />
        </Row>
      </Section>
    </Stack>
  )
}

export default AdvancedTab
