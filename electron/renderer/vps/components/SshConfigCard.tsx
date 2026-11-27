import { Alert, Box, Button, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { DataObjectOutlined, TerminalOutlined } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { VpsAccessMode } from '@shared/types/vps'
import { sshCommand, sshConfigJson } from '@shared/utils/vps'
import SectionCard from '../../components/SectionCard'
import { MONO } from './ui'

const Code = ({ children }: { children: string }) => (
  <Box
    component='pre'
    sx={{ m: 0, p: 2, borderRadius: 2, bgcolor: 'action.hover', fontFamily: MONO, fontSize: 13, lineHeight: 1.6, overflowX: 'auto', userSelect: 'text' }}
  >
    {children}
  </Box>
)

/**
 * SSH Connection Configuration: the JSON object and the ssh command, built
 * from the live server values with JSON.stringify. Never the password.
 */
const SshConfigCard = ({
  host,
  username,
  port,
  mode,
  onModeChange
}: {
  host: string | null
  username: string
  port: number
  mode: VpsAccessMode
  onModeChange: (mode: VpsAccessMode) => void
}) => {
  const json = host ? sshConfigJson(host, username, port) : null
  const command = host ? sshCommand(host, username, port) : null

  const copy = async (text: string | null, what: string) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${what} copied`)
    } catch {
      toast.error('Could not copy to the clipboard')
    }
  }

  return (
    <SectionCard icon='tabler-file-text' title='SSH Connection Configuration' subtitle='Paste into another app, or run the command on the other computer.'>
      <Stack spacing={2.5}>
        <ToggleButtonGroup exclusive size='small' value={mode} onChange={(_e, v: VpsAccessMode | null) => v && onModeChange(v)}>
          <ToggleButton value='local'>Local network</ToggleButton>
          <ToggleButton value='vpn'>VPN</ToggleButton>
        </ToggleButtonGroup>

        {!host ? (
          <Alert severity='warning'>
            {mode === 'vpn'
              ? 'No VPN address found. Connect Tailscale or WireGuard on this computer and it appears here.'
              : 'This computer has no local network address right now.'}
          </Alert>
        ) : (
          <>
            <Code>{json as string}</Code>
            <Code>{command as string}</Code>
          </>
        )}

        <Stack direction='row' spacing={1.5} flexWrap='wrap' useFlexGap>
          <Button variant='contained' startIcon={<DataObjectOutlined />} disabled={!json} onClick={() => void copy(json, 'SSH configuration')}>
            Copy SSH Configuration
          </Button>
          <Button variant='outlined' startIcon={<TerminalOutlined />} disabled={!command} onClick={() => void copy(command, 'SSH command')}>
            Copy SSH Command
          </Button>
        </Stack>
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          The password is not included. On the first connection, check that the host key shown by ssh matches the one listed here.
        </Typography>
      </Stack>
    </SectionCard>
  )
}

export default SshConfigCard
