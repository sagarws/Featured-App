import { describe, expect, it } from 'vitest'
import { chunkBoundaries, collapseRepeats, formatClock, formatTimestamp, isMediaFile, modelSupports, toPlainText, toSrt, toVtt } from '../shared/utils/transcriber'

const segments = [
  { start: 0, end: 3.08, text: 'Hello, this is a test.' },
  { start: 3.42, end: 3725.5, text: 'नमस्ते दुनिया' }
]

describe('transcript formats', () => {
  it('formats timestamps', () => {
    expect(formatTimestamp(3725.5)).toBe('01:02:05,500')
    expect(formatTimestamp(0.0004, '.')).toBe('00:00:00.000')
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(3725)).toBe('1:02:05')
  })

  it('writes srt, vtt and text', () => {
    expect(toSrt(segments)).toBe('1\n00:00:00,000 --> 00:00:03,080\nHello, this is a test.\n\n2\n00:00:03,420 --> 01:02:05,500\nनमस्ते दुनिया\n')
    expect(toVtt(segments).startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:03.080\n')).toBe(true)
    expect(toPlainText(segments)).toBe('Hello, this is a test.\nनमस्ते दुनिया')
    expect(toPlainText(segments, true)).toBe('[0:00] Hello, this is a test.\n[0:03] नमस्ते दुनिया')
  })
})

describe('chunkBoundaries', () => {
  it('keeps short audio in one chunk', () => {
    expect(chunkBoundaries(new Float32Array(16_000 * 10))).toEqual([0, 160_000])
  })

  it('cuts long audio at the quiet moment, every chunk ≤ 28 s', () => {
    const rate = 16_000
    const samples = new Float32Array(rate * 70).map(() => 0.5)
    // Silence at 25.0–25.3 s.
    samples.fill(0, rate * 25, rate * 25.3)
    const bounds = chunkBoundaries(samples, rate)
    expect(bounds[0]).toBe(0)
    expect(bounds.at(-1)).toBe(samples.length)
    expect(bounds[1]! / rate).toBeGreaterThanOrEqual(25)
    expect(bounds[1]! / rate).toBeLessThanOrEqual(25.3)
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]! - bounds[i - 1]!).toBeLessThanOrEqual(28 * rate)
  })
})

describe('helpers', () => {
  it('collapses runaway repeats only', () => {
    expect(collapseRepeats('यह ट्रान्स्व्रिष्' + 'ट्'.repeat(40))).toBe('यह ट्रान्स्व्रिष्ट्')
    expect(collapseRepeats('ha ha ha, well well')).toBe('ha ha ha, well well')
  })

  it('accepts media files and limits the fast model to English', () => {
    expect(isMediaFile('/x/Meeting.MP4')).toBe(true)
    expect(isMediaFile('notes.pdf')).toBe(false)
    expect(modelSupports('fast', 'hi')).toBe(false)
    expect(modelSupports('fast', 'en')).toBe(true)
    expect(modelSupports('accurate', 'hi')).toBe(true)
  })
})
