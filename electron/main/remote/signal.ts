import type { SignalMessage } from '@shared/types/remote'

const MAX_SDP = 256 * 1024

/** A WebRTC signal from a window or from the other computer, checked before it is passed on. */
export const parseSignal = (raw: unknown): SignalMessage | null => {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if ((v['type'] === 'offer' || v['type'] === 'answer') && typeof v['sdp'] === 'string' && v['sdp'].length <= MAX_SDP) {
    return { type: v['type'], sdp: v['sdp'] }
  }
  if (v['type'] === 'candidate' && typeof v['candidate'] === 'string' && v['candidate'].length <= 2048) {
    const mid = v['sdpMid']
    const index = v['sdpMLineIndex']
    return {
      type: 'candidate',
      candidate: v['candidate'],
      sdpMid: typeof mid === 'string' && mid.length <= 64 ? mid : null,
      sdpMLineIndex: typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 64 ? index : null
    }
  }
  if (v['type'] === 'restart') return { type: 'restart' }
  return null
}
