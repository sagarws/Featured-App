import { AUTO_STEPS, encodingPlan } from '@shared/utils/remote'
import type { HostEngineConfig, InputEvent, QualityPreset, QualityPriority, SignalMessage } from '@shared/types/remote'
import { appLog } from '../../utils/appLog'
import { CandidateQueue, candidateSignal, preferCodecs } from '../rtc'

/*
 * The host's hidden capture window (#rd-host). Captures the chosen display,
 * sends it over WebRTC, and passes the viewer's input from the data channels
 * to the main process — which decides, per event, whether it may be injected.
 *
 * Latency choices: the encoder gets contentHint 'text' (sharp text; frames
 * dropped before resolution) or 'motion'; H.264 first where the OS has a
 * hardware encoder; one video stream, no audio; mouse moves on an unordered,
 * no-retransmit channel so a lost move is replaced by the next one instead of
 * delaying it.
 */

type EncodingParams = RTCRtpEncodingParameters & { priority?: string; networkPriority?: string; maxFramerate?: number }
type SendParams = RTCRtpSendParameters & { degradationPreference?: string }

export const runHostEngine = async (): Promise<void> => {
  const api = window.printAgent.remote.engine
  const loaded = await api.config()
  if (!loaded.ok) return
  const config: HostEngineConfig = loaded.value
  let quality: QualityPreset = config.quality
  let priority: QualityPriority = config.priority
  let displayId = config.displayId
  let track: MediaStreamTrack | null = null
  let pc: RTCPeerConnection | null = null
  let sender: RTCRtpSender | null = null
  let autoStep = 0
  let lastMoveSeq = -1
  let stopped = false
  const candidates = new CandidateQueue(() => pc)

  const fail = (message: string): void => {
    appLog('error', 'remote-host', message)
    api.state({ kind: 'error', message })
  }

  const capture = async (id: string): Promise<MediaStreamTrack> => {
    const armed = await api.arm(id)
    if (!armed.ok) throw new Error(armed.error)
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 } }, audio: false })
    const next = stream.getVideoTracks()[0]
    if (!next) throw new Error('No video from the screen capture.')
    next.contentHint = priority === 'readability' ? 'text' : 'motion'
    next.addEventListener('ended', () => {
      if (!stopped && next === track) fail('Screen capture stopped on the shared computer.')
    })
    return next
  }

  const applyQuality = async (): Promise<void> => {
    if (!sender || !track) return
    const { width = 1920, height = 1080 } = track.getSettings()
    const plan = encodingPlan(quality, width, height, autoStep)
    track.contentHint = priority === 'readability' ? 'text' : 'motion'
    try {
      await track.applyConstraints({ frameRate: { max: plan.maxFramerate } })
    } catch {
      // Some capturers ignore frame-rate constraints; the encoder cap below still applies.
    }
    const params = sender.getParameters() as SendParams
    if (!params.encodings?.length) params.encodings = [{}]
    const encoding = params.encodings[0] as EncodingParams
    encoding.maxBitrate = plan.maxBitrate
    encoding.maxFramerate = plan.maxFramerate
    encoding.scaleResolutionDownBy = plan.scaleResolutionDownBy
    encoding.priority = 'high'
    encoding.networkPriority = 'high'
    params.degradationPreference = priority === 'readability' ? 'maintain-resolution' : 'maintain-framerate'
    try {
      await sender.setParameters(params)
    } catch {
      delete params.degradationPreference
      await sender.setParameters(params).catch((error: unknown) => appLog('warn', 'remote-host', `setParameters: ${String(error)}`))
    }
  }

  const onChannelMessage = (channel: RTCDataChannel) => (event: MessageEvent) => {
    if (typeof event.data !== 'string' || event.data.length > 16_384) return
    let msg: unknown
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    // Shape-checked again, per event, in the main process.
    if (Array.isArray(msg)) return api.input(msg.slice(0, 64) as InputEvent[])
    const m = msg as Record<string, unknown>
    if (m['k'] === 'ping') {
      if (channel.readyState === 'open') channel.send(JSON.stringify({ k: 'pong', t: m['t'] }))
      return
    }
    if (m['k'] === 'mm' && typeof m['s'] === 'number') {
      // Unordered channel: an older move arriving late is dropped.
      if (m['s'] <= lastMoveSeq) return
      lastMoveSeq = m['s']
    }
    api.input([m as InputEvent])
  }

  const closePc = (): void => {
    pc?.close()
    pc = null
    sender = null
    candidates.clear()
  }

  const negotiate = async (): Promise<void> => {
    closePc()
    lastMoveSeq = -1
    if (!track || track.readyState === 'ended') track = await capture(displayId)
    const next = new RTCPeerConnection({ iceServers: config.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' })
    pc = next
    const transceiver = next.addTransceiver(track, { direction: 'sendonly' })
    sender = transceiver.sender
    preferCodecs(transceiver, config.codec, config.hardwareAcceleration)
    for (const channel of [next.createDataChannel('input', { ordered: true }), next.createDataChannel('move', { ordered: false, maxRetransmits: 0 })]) {
      channel.onmessage = onChannelMessage(channel)
    }
    next.onicecandidate = event => {
      if (event.candidate && pc === next) api.signal(candidateSignal(event.candidate))
    }
    next.onconnectionstatechange = () => {
      if (pc !== next) return
      if (next.connectionState === 'connected') {
        api.state({ kind: 'connected' })
        void applyQuality()
      }
    }
    const offer = await next.createOffer()
    await next.setLocalDescription(offer)
    api.signal({ type: 'offer', sdp: offer.sdp ?? '' })
  }

  const switchDisplay = async (id: string): Promise<void> => {
    const next = await capture(id)
    const old = track
    track = next
    displayId = id
    if (sender) await sender.replaceTrack(next)
    old?.stop()
    autoStep = 0
    await applyQuality()
    api.state({ kind: 'display', id })
  }

  const stop = (): void => {
    stopped = true
    closePc()
    track?.stop()
    track = null
  }

  api.onSignal((signal: SignalMessage) => {
    if (!pc) return
    if (signal.type === 'answer') {
      void pc
        .setRemoteDescription({ type: 'answer', sdp: signal.sdp })
        .then(() => {
          candidates.flush()
          return applyQuality()
        })
        .catch((error: unknown) => fail(`Could not start the stream: ${String(error)}`))
    } else if (signal.type === 'candidate') {
      candidates.add(signal)
    }
  })

  api.onCommand(command => {
    if (stopped) return
    if (command.type === 'start') void negotiate().catch((error: unknown) => fail(`Could not share the screen: ${error instanceof Error ? error.message : String(error)}`))
    else if (command.type === 'quality') {
      quality = command.preset
      priority = command.priority
      autoStep = 0
      void applyQuality()
    } else if (command.type === 'display') void switchDisplay(command.id).catch((error: unknown) => fail(`Could not switch the screen: ${String(error)}`))
    else if (command.type === 'stop') stop()
  })

  // Auto quality: step down while the encoder is held back by bandwidth or CPU, back up when there is headroom.
  let limited = 0
  let headroom = 0
  setInterval(() => {
    if (quality !== 'auto' || !sender || pc?.connectionState !== 'connected') return
    void pc.getStats().then(report => {
      let reason = 'none'
      let available = 0
      report.forEach((s: Record<string, unknown>) => {
        if (s['type'] === 'outbound-rtp' && s['kind'] === 'video' && typeof s['qualityLimitationReason'] === 'string') reason = s['qualityLimitationReason']
        if (s['type'] === 'candidate-pair' && s['nominated'] === true && typeof s['availableOutgoingBitrate'] === 'number') available = s['availableOutgoingBitrate']
      })
      const { width = 1920, height = 1080 } = track?.getSettings() ?? {}
      if (reason === 'bandwidth' || reason === 'cpu') {
        headroom = 0
        if (++limited >= 2 && autoStep < AUTO_STEPS - 1) {
          autoStep++
          limited = 0
          void applyQuality()
        }
      } else {
        limited = 0
        const up = autoStep > 0 ? encodingPlan('auto', width, height, autoStep - 1) : null
        if (up && available > up.maxBitrate * 1.2 && ++headroom >= 4) {
          autoStep--
          headroom = 0
          void applyQuality()
        }
      }
    })
  }, 2000)

  window.addEventListener('beforeunload', stop)
  api.state({ kind: 'ready' })
}
