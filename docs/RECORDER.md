# Recorder — screen, webcam and audio recording

Sidebar → **Recorder**. Record the screen (full display or a dragged region),
the webcam, or audio. System audio is the default source. Long recordings are
written to disk in segments as they run, so a crash, quit or power cut loses
at most the last second or two.

## Architecture

```
Recorder window (#engine, hidden)                  Main process (electron/main/recorder)
  getDisplayMedia → screen (+ system audio)          session.ts   one session at a time, lifecycle, heartbeat, disk watch
  getUserMedia    → webcam / microphone              segmenter.ts ffmpeg child: stdin → segment_001.mkv, 002, …  (stream copy)
  WebAudio mix: system + mic × volume                finalize.ts  probe → repair → concat → validate → delete segments
  region crop: VideoFrame visibleRect (no copy)      library.ts   list / rename / delete / export, recovery, recording-media://
  MediaRecorder H.264 + Opus, keyframe every 2 s     capture.ts   display source + loopback audio, permissions
        │ 1 s chunks over IPC (awaited = backpressure) windows.ts   engine, toolbar, region overlays, border, camera bubble
        └──────────────────────────────────────────▶ storage.ts   folders, durable manifest.json, free space
```

* **No re-encoding while recording.** Chromium's MediaRecorder encodes (hardware
  H.264 where available); ffmpeg only copies the stream into segment files.
* **Segments without gaps.** One continuous MediaRecorder stream is cut by
  ffmpeg's segment muxer at the first keyframe after each mark (≤ 2 s late), so
  no frame is lost or repeated at a cut. Verified in `tests/recorderPipeline.test.ts`
  (420 of 420 frames after a 5-segment merge).
* **Merge** uses ffmpeg's concat demuxer with video stream-copy. MP4 output turns
  Opus into AAC so QuickTime/Windows can play it; MKV keeps audio as is.
* **Helper windows** load the same page at a hash route (`electron/renderer/main.tsx`):
  `#engine`, `#toolbar` and `#border` (both excluded from the capture with content
  protection), `#region` (one overlay per display), `#camera` (the webcam bubble,
  deliberately captured).

### Folder layout

```
<Videos>/Featured Recordings/          (change in Recorder → Settings)
  Screen/Session_2026-11-17_10-00-05/
    segment_001.mkv  segment_002.mkv  …   (removed after a verified merge unless "Keep segment files" is on)
    segments.csv                          (ffmpeg's list of finished segments)
    manifest.json (+ .bak)                (durable: fsync + backup, see durableJson.ts)
    Screen recording 17 Nov 2026, 10_00.mp4
    thumbnail.jpg
  Webcam/…
  Audio/…
```

## Crash recovery

1. Every chunk (~1 s) goes straight to ffmpeg; nothing accumulates in memory.
2. ffmpeg closes and flushes a Matroska cluster every second
   (`-segment_format_options cluster_time_limit=1000:flush_packets=1`), so the
   segment being written is on disk while recording.
3. Finished segments are closed files listed in `segments.csv`.
4. `manifest.json` (session id, kind, status, segments, timestamps, recorded
   seconds) is rewritten durably on every state change and every 5 s.
5. **App crash or quit:** ffmpeg's stdin closes and it finishes the current segment
   properly. A normal quit while recording stops cleanly and marks the session
   for recovery.
6. **App and ffmpeg both killed:** the cut-short segment has no index. Recovery
   remuxes it with errors ignored and keeps every whole cluster.
7. **Next start:** any session still in a live state is marked `interrupted`.
   The Recorder page then shows *"An interrupted recording was detected. Would
   you like to recover it?"* with **Recover Recording**, **View Saved Segments**
   and **Discard Session** (Discard moves the folder to the trash).
8. **Recover:** probe every segment → repair what can be repaired → skip
   unreadable ones (and report them) → join in order → check the joined file's
   length against the segments → only then delete the segments. If anything is
   skipped, the segments are kept.

Not recoverable: media still inside Chromium's encoder or in the ~1 s chunk not
yet handed over when the process died, and data the OS had not written to disk
before a power cut.

## OS support

| | System audio | Microphone | Webcam | Full screen / display | Region | Toolbar hidden from capture |
|---|---|---|---|---|---|---|
| **Windows 10/11** | ✅ WASAPI loopback (Electron) | ✅ | ✅ | ✅ | ✅ | ✅ Win10 2004+ |
| **macOS 14.2+** | ✅ Core Audio tap (Chromium `MacCatapLoopbackAudioForScreenShare`). Needs Screen & System Audio Recording permission | ✅ | ✅ | ✅ | ✅ | ✅ |
| **macOS 13–14.1** | ❌ The app says so and offers Microphone / No audio | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Linux** | ⚠️ PulseAudio/PipeWire "Monitor of …" source, if present | ✅ | ✅ | ✅ X11; Wayland via portal | ✅ X11 | ❌ |

System audio captures everything sent to the system output; choosing one
output device is not offered by the capture APIs.

## Permissions (macOS)

On first use macOS asks for Screen Recording (and System Audio Recording),
Microphone and Camera. The app then needs a restart for Screen Recording to take
effect. Packaged builds carry the usage strings (`electron-builder.yml`) and the
audio-input/camera entitlements (`build/entitlements.mac.plist`). Without the
permission, macOS returns the desktop wallpaper only, or silent system audio.

**Silent system audio.** A refused system-audio permission does not fail: the
track arrives but every sample is zero. The capture window watches for that.
If nothing but zeros comes for 6 s, the toolbar shows **No system sound · Fix**
(opens the privacy pane), the app shows a warning, and a system notification
appears. Real sound clears it. A recording that stayed silent throughout says so
when saved. **In development**, macOS asks on behalf of the app that started
`npm run dev` (Terminal, iTerm, VS Code, Antigravity…). That app needs
*System Audio Recording*, and it must be restarted after the change.

## ffmpeg

Needed for segmenting, merging, repair and thumbnails. Lookup order:
`FFMPEG_PATH` + `FFPROBE_PATH` → bundled `<resources>/ffmpeg/` → `PATH` (and Homebrew).

* **Development:** any installed ffmpeg (`brew install ffmpeg`).
* **Packaged builds:** `npm run build:mac|build:win|build:linux` first runs
  `scripts/fetch-ffmpeg.cjs`, which places an **LGPL** ffmpeg in
  `resources/ffmpeg/<os>-<arch>/`. That's BtbN's LGPL build on Windows/Linux, and
  on macOS a minimal LGPL build compiled from the official 9.0 source (Xcode
  command line tools; mac-x64 is cross-built). The recorder needs no GPL codec.

## Tests

`npm test` runs:
* `tests/recorder.test.ts`: settings defaults (system audio, 30-minute segments),
  140 min → 30/30/30/30/20, live segment position, ffmpeg arguments, CSV
  parsing, safe names, interrupted-state detection, region crop on HiDPI.
* `tests/recorderPipeline.test.ts` (real ffmpeg; skipped if none):
  * 14 s cut into 5 segments and merged to a validated MP4, with no lost or
    doubled frames and A/V in step;
  * crash mid-segment (SIGKILL) then recovery;
  * corrupt segment skipped, the rest joined in order;
  * the live segment has data on disk while recording;
  * audio-only to M4A.

Development switches (ignored in packaged builds):
* `RECORDER_TEST_SEGMENT_SECONDS=10 npm run dev` cuts 10-second segments, to
  try splitting and recovery quickly.
* `RECORDER_DEBUG_RAW=1` also keeps the raw MediaRecorder stream as `raw-input.mkv`.

### Manual checklist (needs real devices and OS permissions)

| # | Scenario | How |
|---|---|---|
| 1–4 | Full screen with no audio / system / mic / system+mic | Record Screen → choose audio → record 1 min while playing a YouTube video and speaking → play the result |
| 5 | Custom region | Record Screen → Custom region → drag, move, resize → Record this area. Esc cancels |
| 6 | Multiple monitors | Pick each display in the Display list; draw a region on the second display |
| 7 | Pause / Resume / Stop | Toolbar buttons; the pause is not in the video |
| 8–10 | Segmentation and merge | `RECORDER_TEST_SEGMENT_SECONDS=30`, record 2:20 → 5 segments → one merged file |
| 11–13, 18 | Crash recovery | Force-quit the app (Activity Monitor / Task Manager) after the 1st segment and during the 2nd → reopen → Recover |
| 14 | Corrupt segment | With "Keep segment files" on, overwrite one segment with junk → Recover → it is skipped and reported |
| 15 | Low disk | Choose a recording folder on a nearly full volume: refuses to start below 2 GB, stops and saves below 500 MB |
| 16 | Mic unplugged | Unplug a USB mic while recording → the toolbar shows it disconnected, recording continues; plug back in → restored |
| 17 | System-audio permission denied | Remove the app from *System Audio Recording* and play sound → after ~6 s the toolbar shows *No system sound · Fix*, plus a notification; the saved recording warns too |

## Known limitations

* **macOS system audio** relies on a Chromium feature flag for Core Audio taps
  (Electron officially documents loopback for Windows only). It was verified to
  return a system-audio track in Electron 43; the sound itself needs the macOS
  permission. If a future Electron drops the flag, a native ScreenCaptureKit
  helper is the fallback (not included).
* The resolution setting caps full-display recordings. A region is recorded at
  native pixels.
* Linux system audio needs a PulseAudio/PipeWire monitor source. On Wayland,
  the system portal picks the screen, so per-display/region selection may be limited.
* Webcam overlay is a floating window captured with the screen, so it can be
  moved and resized while recording.
