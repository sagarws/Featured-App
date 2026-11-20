import { useEffect, useState } from 'react'
import type { CaptureInfo } from '@shared/types/screenshot'

/** A held capture as an object URL, for the thumbnail and pin windows. */
export const useCaptureUrl = (id: string): { url: string | null; info: CaptureInfo | null; error: string | null } => {
  const [url, setUrl] = useState<string | null>(null)
  const [info, setInfo] = useState<CaptureInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let objectUrl: string | null = null
    let active = true
    void window.printAgent.screenshot.getCapture(id).then(result => {
      if (!active) return
      if (!result.ok || !result.value) {
        setError(result.ok ? 'This screenshot is no longer available.' : result.error)
        return
      }
      const { png, ...rest } = result.value
      objectUrl = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }))
      setUrl(objectUrl)
      setInfo(rest)
    })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id])

  return { url, info, error }
}
