import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import type { GoogleStatus } from '@shared/types/google'

const api = () => window.printAgent.google

/** The connected Google account, live, with connect / disconnect. */
export const useGoogle = (): {
  status: GoogleStatus | null
  connect: () => Promise<boolean>
  cancel: () => void
  disconnect: () => Promise<void>
} => {
  const [status, setStatus] = useState<GoogleStatus | null>(null)

  useEffect(() => {
    let active = true
    void api()
      .status()
      .then(r => {
        if (active && r.ok) setStatus(r.value)
      })
    const off = api().onChanged(next => setStatus(next))
    return () => {
      active = false
      off()
    }
  }, [])

  const connect = useCallback(async () => {
    const r = await api().connect()
    if (r.ok) {
      toast.success(`Google Drive connected: ${r.value.email}`)
      return true
    }
    if (!/cancelled|restarted/i.test(r.error)) toast.error(r.error, { duration: 9000 })
    return false
  }, [])

  const cancel = useCallback(() => void api().cancelConnect(), [])

  const disconnect = useCallback(async () => {
    const r = await api().disconnect()
    if (!r.ok) toast.error(r.error)
    else toast.success('Google Drive disconnected')
  }, [])

  return { status, connect, cancel, disconnect }
}
