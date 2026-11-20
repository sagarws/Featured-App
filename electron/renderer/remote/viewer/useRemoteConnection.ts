import { useCallback, useEffect, useRef, useState } from 'react'
import type { InputEvent, SignalMessage, ViewerConfig, ViewerStats } from '@shared/types/remote'
import { CandidateQueue, candidateSignal, preferCodecs, viewerStats } from '../rtc'

/*
 * The viewer's side of WebRTC. The host offers (video + two data channels);
 * every offer gets a fresh RTCPeerConnection here, which keeps reconnects
 * simple: after a network drop the host just sends a new offer.
 */

export type MediaState = 'connecting' | 'connected' | 'interrupted'

type Receiver = RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number }

export const useRemoteConnection = (config: ViewerConfig | null, video: React.RefObject<HTMLVideoElement | null>) => {
  const api = window.printAgent.remote.viewer
  const pc = useRef<RTCPeerConnection | null>(null)
  const input = useRef<RTCDataChannel | null>(null)
  const move = useRef<RTCDataChannel | null>(null)
  const [media, setMedia] = useState<MediaState>('connecting')
  const [stats, setStats] = useState<ViewerStats | null>(null)
  const inputRtt = useRef<number | null>(null)

  useEffect(() => {
    if (!config) return
    let disposed = false
    let restartTimer: number | null = null
    const candidates = new CandidateQueue(() => pc.current)

    const requestRestart = (): void => {
      if (restartTimer !== null || disposed) return
      restartTimer = window.setTimeout(() => {
        restartTimer = null
        void api.restart()
      }, 2500)
    }

    const onOffer = async (sdp: string): Promise<void> => {
      pc.current?.close()
      candidates.clear()
      const next = new RTCPeerConnection({ iceServers: config.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' })
      pc.current = next
      next.ontrack = event => {
        const receiver = event.receiver as Receiver
        // As little buffering as possible: render each frame as soon as it is decoded.
        try {
          receiver.jitterBufferTarget = 0
        } catch {
          // older Chromium
        }
        try {
          receiver.playoutDelayHint = 0
        } catch {
          // not supported
        }
        const stream = event.streams[0] ?? new MediaStream([event.track])
        if (video.current) {
          video.current.srcObject = stream
          void video.current.play().catch(() => undefined)
        }
      }
      next.ondatachannel = event => {
        const channel = event.channel
        if (channel.label === 'input') {
          input.current = channel
          channel.onmessage = e => {
            if (typeof e.data !== 'string') return
            try {
              const msg = JSON.parse(e.data) as { k?: string; t?: number }
              if (msg.k === 'pong' && typeof msg.t === 'number') inputRtt.current = Math.round((performance.now() - msg.t) * 10) / 10
            } catch {
              // ignore
            }
          }
        } else if (channel.label === 'move') move.current = channel
      }
      next.onicecandidate = event => {
        if (event.candidate && pc.current === next) api.signal(candidateSignal(event.candidate))
      }
      next.onconnectionstatechange = () => {
        if (pc.current !== next) return
        const state = next.connectionState
        if (state === 'connected') setMedia('connected')
        else if (state === 'disconnected') setMedia('interrupted')
        else if (state === 'failed') {
          setMedia('interrupted')
          requestRestart()
        }
      }
      await next.setRemoteDescription({ type: 'offer', sdp })
      // The answer's codec order decides what the host encodes: H.264 (hardware) first unless chosen otherwise.
      for (const transceiver of next.getTransceivers()) {
        if (transceiver.receiver.track.kind === 'video') preferCodecs(transceiver, config.codec, config.hardwareAcceleration)
      }
      candidates.flush()
      const answer = await next.createAnswer()
      await next.setLocalDescription(answer)
      api.signal({ type: 'answer', sdp: answer.sdp ?? '' })
    }

    const off = api.onSignal((signal: SignalMessage) => {
      if (signal.type === 'offer') {
        setMedia('connecting')
        void onOffer(signal.sdp).catch(() => requestRestart())
      } else if (signal.type === 'candidate') candidates.add(signal)
    })
    void api.ready()

    // Input round trip (viewer → host capture window → back) and media stats, once a second.
    let sample: { bytes: number; at: number } | null = null
    const ticker = window.setInterval(() => {
      const channel = input.current
      if (channel?.readyState === 'open') channel.send(JSON.stringify({ k: 'ping', t: performance.now() }))
      const current = pc.current
      if (!current) return
      void current.getStats().then(report => {
        const result = viewerStats(report, sample)
        sample = result.sample
        if (!disposed) setStats({ ...result.stats, inputRttMs: inputRtt.current })
      })
    }, 1000)

    return () => {
      disposed = true
      off()
      window.clearInterval(ticker)
      if (restartTimer !== null) window.clearTimeout(restartTimer)
      pc.current?.close()
      pc.current = null
      input.current = null
      move.current = null
    }
  }, [config, api, video])

  /** Clicks, keys, wheel: ordered and reliable. */
  const sendInput = useCallback((event: InputEvent) => {
    const channel = input.current
    if (channel?.readyState === 'open') channel.send(JSON.stringify(event))
  }, [])

  /** Pointer moves: unordered, never retransmitted — a newer move replaces a lost one. */
  const sendMove = useCallback((x: number, y: number, seq: number) => {
    const channel = move.current
    if (channel?.readyState === 'open') channel.send(JSON.stringify({ k: 'mm', x, y, s: seq }))
  }, [])

  return { media, stats, sendInput, sendMove }
}
