import type { CodecPreference, SignalMessage, ViewerStats } from '@shared/types/remote'

/** Shared WebRTC helpers for the host engine and the viewer. */

/** Order the codecs: the preferred one first, the rest kept as fallbacks (RTX/RED/FEC stay in). */
export const preferCodecs = (transceiver: RTCRtpTransceiver, codec: CodecPreference, hardware: boolean): string => {
  const caps = RTCRtpSender.getCapabilities('video')
  if (!caps || typeof transceiver.setCodecPreferences !== 'function') return 'default'
  const order =
    codec === 'h264'
      ? ['video/H264', 'video/VP9', 'video/VP8']
      : codec === 'vp9'
        ? ['video/VP9', 'video/H264', 'video/VP8']
        : codec === 'av1'
          ? ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8']
          : hardware
            ? ['video/H264', 'video/VP9', 'video/VP8']
            : ['video/VP9', 'video/H264', 'video/VP8']
  const rank = (c: RTCRtpCodec): number => {
    const index = order.indexOf(c.mimeType)
    if (index < 0) return 100
    // Within H.264: packetization-mode=1 and the High profile first.
    const fmtp = c.sdpFmtpLine ?? ''
    return index * 10 + (fmtp.includes('packetization-mode=1') ? 0 : 2) + (fmtp.includes('profile-level-id=64') ? 0 : 1)
  }
  const sorted = [...caps.codecs].sort((a, b) => rank(a) - rank(b))
  try {
    transceiver.setCodecPreferences(sorted)
    return sorted[0]?.mimeType ?? 'default'
  } catch {
    return 'default'
  }
}

export const candidateSignal = (c: RTCIceCandidate): SignalMessage => ({ type: 'candidate', candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex })

/** Holds ICE candidates that arrive before the remote description. */
export class CandidateQueue {
  private queue: RTCIceCandidateInit[] = []
  constructor(private readonly pc: () => RTCPeerConnection | null) {}

  add(signal: Extract<SignalMessage, { type: 'candidate' }>): void {
    const init: RTCIceCandidateInit = { candidate: signal.candidate, sdpMid: signal.sdpMid, sdpMLineIndex: signal.sdpMLineIndex }
    const pc = this.pc()
    if (pc?.remoteDescription) void pc.addIceCandidate(init).catch(() => undefined)
    else this.queue.push(init)
  }

  flush(): void {
    const pc = this.pc()
    if (!pc) return
    for (const c of this.queue.splice(0)) void pc.addIceCandidate(c).catch(() => undefined)
  }

  clear(): void {
    this.queue = []
  }
}

type StatsMap = Map<string, Record<string, unknown>>

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Viewer-side numbers for the stats panel, from two getStats() reports a second apart. */
export const viewerStats = (report: RTCStatsReport, previous: { bytes: number; at: number } | null): { stats: Omit<ViewerStats, 'inputRttMs'>; sample: { bytes: number; at: number } } => {
  const all: StatsMap = new Map()
  report.forEach((value: Record<string, unknown>, key: string) => all.set(key, value))
  let inbound: Record<string, unknown> | undefined
  let pair: Record<string, unknown> | undefined
  for (const s of all.values()) {
    if (s['type'] === 'inbound-rtp' && s['kind'] === 'video') inbound = s
    if (s['type'] === 'candidate-pair' && (s['nominated'] === true || s['selected'] === true) && s['state'] === 'succeeded') pair = s
  }
  const bytes = num(inbound?.['bytesReceived']) ?? 0
  const at = num(inbound?.['timestamp']) ?? performance.now()
  const bitrateKbps = previous && at > previous.at ? Math.round(((bytes - previous.bytes) * 8) / (at - previous.at)) : 0
  const codecId = typeof inbound?.['codecId'] === 'string' ? inbound['codecId'] : ''
  const mime = codecId ? all.get(codecId)?.['mimeType'] : undefined
  const codec = typeof mime === 'string' ? mime.replace('video/', '') : ''
  const decoded = num(inbound?.['framesDecoded'])
  const decodeTime = num(inbound?.['totalDecodeTime'])
  const jbDelay = num(inbound?.['jitterBufferDelay'])
  const jbCount = num(inbound?.['jitterBufferEmittedCount'])
  const lost = num(inbound?.['packetsLost']) ?? 0
  const received = num(inbound?.['packetsReceived']) ?? 0
  const local = pair ? all.get(String(pair['localCandidateId'])) : undefined
  const remote = pair ? all.get(String(pair['remoteCandidateId'])) : undefined
  const types = [local?.['candidateType'], remote?.['candidateType']]
  const route: ViewerStats['route'] = !pair ? 'unknown' : types.includes('relay') ? 'relay' : types.every(t => t === 'host') ? 'lan' : 'direct'
  const rtt = num(pair?.['currentRoundTripTime'])
  return {
    sample: { bytes, at },
    stats: {
      fps: Math.round(num(inbound?.['framesPerSecond']) ?? 0),
      width: num(inbound?.['frameWidth']) ?? 0,
      height: num(inbound?.['frameHeight']) ?? 0,
      bitrateKbps,
      rttMs: rtt === null ? null : Math.round(rtt * 1000),
      packetLossPct: received + lost > 0 ? Math.round((lost / (received + lost)) * 1000) / 10 : 0,
      jitterBufferMs: jbDelay !== null && jbCount ? Math.round((jbDelay / jbCount) * 1000) : null,
      decodeMs: decodeTime !== null && decoded ? Math.round((decodeTime / decoded) * 10000) / 10 : null,
      codec,
      route,
      qualityLimitation: null
    }
  }
}
