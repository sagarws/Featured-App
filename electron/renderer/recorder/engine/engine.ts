import { RECORDER_TUNING, RESOLUTION_SIZE } from '@shared/constants/recorder'
import type { EngineConfig } from '@shared/types/recorder'
import { candidateMimeTypes, wantsMic, wantsSystemAudio } from '@shared/utils/recorder'
import { cropVideoTrack } from './crop'

/*
 * The hidden capture window (#engine). Opens the streams, mixes the audio,
 * crops a region, runs MediaRecorder and hands every ~1 s chunk to the main
 * process, which pipes it straight into ffmpeg. Nothing accumulates here:
 * each chunk is sent, awaited (backpressure), and dropped.
 */

const api = () => window.printAgent.recorder

const isLinux = navigator.userAgent.includes('Linux')

const stopAll = (stream: MediaStream | null) => stream?.getTracks().forEach(t => t.stop())

const RAW_AUDIO: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

/** Linux: the PulseAudio / PipeWire "Monitor of …" input is the system output. */
const linuxMonitorDevice = async (): Promise<string | null> => {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.find(d => d.kind === 'audioinput' && /monitor/i.test(d.label))?.deviceId ?? null
}

const openMic = (deviceId: string | null): Promise<MediaStream> =>
  navigator.mediaDevices.getUserMedia({
    audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  })

/**
 * When the OS refuses system audio (macOS without the "System Audio Recording"
 * permission) the track still arrives, but every sample is exactly zero. Any
 * real sound is not. Reports 'system-silent' if nothing but zeros came for a
 * while, and 'system-audible' as soon as sound appears; then it stops watching,
 * because sound proves the capture works and a quiet pause later is normal.
 */
const watchSystemSilence = (ctx: AudioContext, source: AudioNode): (() => void) => {
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  const started = performance.now()
  let warned = false
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples)
    if (samples.some(v => v !== 0)) {
      void api().engine.event('system-audible')
      stop()
    } else if (!warned && performance.now() - started >= RECORDER_TUNING.systemSilenceWarnMs) {
      warned = true
      void api().engine.event('system-silent')
    }
  }, 200)
  const stop = () => {
    window.clearInterval(timer)
    source.disconnect(analyser)
  }
  return stop
}

const pickMimeType = (cfg: EngineConfig): string => {
  const type = candidateMimeTypes(cfg.kind).find(t => MediaRecorder.isTypeSupported(t))
  if (!type) throw new Error('This computer cannot encode recordings (no supported MediaRecorder format).')
  return type
}

export const runEngine = async (): Promise<void> => {
  const configResult = await api().engine.config()
  if (!configResult.ok || !configResult.value) return
  const cfg = configResult.value
  const streams: MediaStream[] = []
  const stopFns: (() => void)[] = []
  let audioContext: AudioContext | null = null

  const cleanup = () => {
    stopFns.forEach(fn => fn())
    streams.forEach(stopAll)
    void audioContext?.close()
  }

  try {
    const size = RESOLUTION_SIZE[cfg.resolution]
    const wantSystem = wantsSystemAudio(cfg.audio)
    const wantMicrophone = wantsMic(cfg.audio) || (cfg.kind === 'webcam' && cfg.audio !== 'none')

    // ── video (and system audio through the screen capture) ──
    let video: MediaStreamTrack | null = null
    let system: MediaStreamTrack | null = null

    if (cfg.kind === 'screen' || (wantSystem && !isLinux)) {
      const region = cfg.area?.type === 'region'
      const display = await navigator.mediaDevices.getDisplayMedia({
        video:
          cfg.kind === 'screen'
            ? {
                frameRate: { ideal: cfg.fps, max: cfg.fps },
                // A region is cropped from the full-resolution frame.
                ...(region ? {} : { width: { max: size.width }, height: { max: size.height } })
              }
            : // Audio-only: the capture exists for its sound; keep the video tiny and idle.
              { frameRate: { max: 1 }, width: { max: 320 }, height: { max: 240 } },
        audio: wantSystem ? RAW_AUDIO : false
      })
      streams.push(display)
      if (cfg.kind === 'screen') video = display.getVideoTracks()[0] ?? null
      system = display.getAudioTracks()[0] ?? null
      if (cfg.kind === 'screen' && !video) throw new Error('The screen capture returned no video.')
    }

    if (wantSystem && isLinux) {
      const monitor = await linuxMonitorDevice()
      if (!monitor) throw new Error('No system-audio "Monitor" source was found (PulseAudio/PipeWire). Choose Microphone or No audio.')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: monitor }, ...RAW_AUDIO } })
      streams.push(stream)
      system = stream.getAudioTracks()[0] ?? null
    }

    if (wantSystem && !system) {
      throw new Error(
        navigator.userAgent.includes('Mac')
          ? 'System audio could not be captured. Allow "System Audio Recording" for this app in System Settings → Privacy & Security, or choose Microphone / No audio.'
          : 'System audio could not be captured on this computer. Choose Microphone or No audio.'
      )
    }

    if (cfg.kind === 'webcam') {
      const cam = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(cfg.cameraDeviceId ? { deviceId: { exact: cfg.cameraDeviceId } } : {}),
          width: { ideal: size.width },
          height: { ideal: size.height },
          frameRate: { ideal: cfg.fps }
        },
        audio: false
      })
      streams.push(cam)
      video = cam.getVideoTracks()[0] ?? null
      if (!video) throw new Error('The camera returned no video.')
    }

    if (video && cfg.area?.type === 'region' && cfg.displayBounds) {
      const cropped = cropVideoTrack(video, cfg.area, cfg.displayBounds, cfg.fps)
      stopFns.push(cropped.stop)
      video = cropped.track
    }

    // ── audio mix: system + microphone (with volume) into one track ──
    let mic: MediaStreamTrack | null = null
    let micGain: GainNode | null = null
    let audioOut: MediaStreamTrack | null = null
    if (system || wantMicrophone) {
      audioContext = new AudioContext({ sampleRate: 48_000, latencyHint: 'playback' })
      await audioContext.resume()
      const ctx = audioContext
      const destination = ctx.createMediaStreamDestination()
      if (system) {
        const source = ctx.createMediaStreamSource(new MediaStream([system]))
        source.connect(destination)
        stopFns.push(watchSystemSilence(ctx, source))
      }
      if (wantMicrophone) {
        micGain = ctx.createGain()
        micGain.gain.value = cfg.micVolume / 100
        micGain.connect(destination)
        const attach = async (deviceId: string | null): Promise<boolean> => {
          const stream = await openMic(deviceId)
          streams.push(stream)
          const track = stream.getAudioTracks()[0]
          if (!track || !micGain) return false
          ctx.createMediaStreamSource(stream).connect(micGain)
          mic = track
          // Unplugged: keep recording (silence on the mic), say so, and take it back when a mic returns.
          track.addEventListener('ended', () => {
            mic = null
            void api().engine.event('mic-lost')
          })
          return true
        }
        await attach(cfg.micDeviceId)
        const onDeviceChange = () => {
          if (mic) return
          void attach(cfg.micDeviceId)
            .catch(() => attach(null))
            .then(ok => {
              if (ok) void api().engine.event('mic-restored')
            })
            .catch(() => undefined)
        }
        navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
        stopFns.push(() => navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange))
      }
      audioOut = destination.stream.getAudioTracks()[0] ?? null
    }

    if (video) {
      video.addEventListener('ended', () => void api().engine.event('video-ended'))
    }

    const tracks = [video, audioOut].filter((t): t is MediaStreamTrack => !!t)
    if (tracks.length === 0) throw new Error('Nothing to record.')
    if (cfg.kind === 'audio' && !audioOut) throw new Error('No audio source could be opened.')

    // ── MediaRecorder → main process ──
    const mimeType = pickMimeType(cfg)
    const recorder = new MediaRecorder(new MediaStream(tracks), {
      mimeType,
      audioBitsPerSecond: cfg.audioBitsPerSecond,
      ...(cfg.kind !== 'audio' ? { videoBitsPerSecond: cfg.videoBitsPerSecond } : {}),
      // Chromium: a keyframe at least this often, so segments cut near the mark.
      videoKeyFrameIntervalDuration: cfg.keyframeIntervalMs
    } as MediaRecorderOptions)

    let chain: Promise<void> = Promise.resolve()
    let failed = false
    recorder.ondataavailable = event => {
      if (event.data.size === 0) return
      const blob = event.data
      chain = chain.then(async () => {
        if (failed) return
        const result = await api().engine.chunk(new Uint8Array(await blob.arrayBuffer()))
        if (!result.ok) {
          failed = true
          void api().engine.failed(`Writing the recording failed: ${result.error}`)
          if (recorder.state !== 'inactive') recorder.stop()
        }
      })
    }
    recorder.onerror = event => {
      const error = (event as unknown as { error?: DOMException }).error
      void api().engine.failed(`The encoder stopped: ${error?.message ?? 'unknown error'}`)
    }
    recorder.onstop = () => {
      // Every chunk is in the main process before Stop is acknowledged.
      void chain.finally(() => {
        cleanup()
        void api().engine.stopped()
      })
    }

    api().engine.onCommand(command => {
      if (command === 'pause' && recorder.state === 'recording') recorder.pause()
      else if (command === 'resume' && recorder.state === 'paused') recorder.resume()
      else if (command === 'stop') {
        if (recorder.state !== 'inactive') recorder.stop()
        else void api().engine.stopped()
      }
    })

    recorder.start(cfg.timesliceMs)
    await api().engine.ready({ mimeType: recorder.mimeType || mimeType, systemAudio: !!system, microphone: !!mic })
  } catch (error) {
    cleanup()
    const err = error as DOMException
    const message =
      err?.name === 'NotAllowedError'
        ? 'Permission was refused. Check Screen Recording, Microphone and Camera access for this app in your privacy settings.'
        : err?.name === 'NotFoundError'
          ? 'The selected device was not found. Is it connected?'
          : err?.name === 'NotReadableError'
            ? 'The device is in use by another app or could not be opened.'
            : err instanceof Error
              ? err.message
              : String(error)
    void api().engine.failed(message)
  }
}
