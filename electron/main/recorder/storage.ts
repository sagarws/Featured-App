import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { KIND_FOLDER, MANIFEST_FILE, RECORDINGS_FOLDER_NAME } from '@shared/constants/recorder'
import type { RecordingKind, SessionManifest } from '@shared/types/recorder'
import { isValidManifest, sessionFolderName, uniqueName } from '@shared/utils/recorder'
import { readDurableJson, writeDurableJson } from '../durableJson'
import { logger } from '../logger'
import { getSettings } from '../settings'

/*
 * Recordings/
 *   Screen/Session_2026-11-17_10-00-05/{segment_001.mkv, …, manifest.json, <name>.mp4, thumbnail.jpg}
 *   Webcam/…
 *   Audio/…
 */

export const recordingsRoot = (): string =>
  getSettings().recorder.outputDir ?? join(app.getPath('videos'), RECORDINGS_FOLDER_NAME)

export const kindDir = (kind: RecordingKind): string => join(recordingsRoot(), KIND_FOLDER[kind])

/** A new, empty session folder; never reuses an existing one. */
export const createSessionDir = (kind: RecordingKind, date: Date): string => {
  const parent = kindDir(kind)
  mkdirSync(parent, { recursive: true })
  const name = uniqueName(sessionFolderName(date), n => existsSync(join(parent, n)))
  const dir = join(parent, name)
  mkdirSync(dir)
  return dir
}

export const manifestPath = (dir: string): string => join(dir, MANIFEST_FILE)

/** Flushed to disk with a backup copy (see durableJson.ts), so a crash cannot lose it. */
export const saveManifest = (dir: string, manifest: SessionManifest): void => {
  manifest.updatedAt = new Date().toISOString()
  writeDurableJson(manifestPath(dir), manifest)
}

export const loadManifest = (dir: string): SessionManifest | null => {
  try {
    return readDurableJson<SessionManifest>(manifestPath(dir), isValidManifest)
  } catch {
    return null
  }
}

/** Every session folder with a readable manifest, newest first. */
export const listSessions = (): { dir: string; manifest: SessionManifest }[] => {
  const out: { dir: string; manifest: SessionManifest }[] = []
  for (const kind of Object.keys(KIND_FOLDER) as RecordingKind[]) {
    const parent = kindDir(kind)
    if (!existsSync(parent)) continue
    let names: string[]
    try {
      names = readdirSync(parent, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
    } catch (error) {
      logger.warn(`[recorder] cannot read ${parent}`, error)
      continue
    }
    for (const name of names) {
      const dir = join(parent, name)
      const manifest = loadManifest(dir)
      if (manifest) out.push({ dir, manifest })
    }
  }
  return out.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))
}

export const findSession = (id: string): { dir: string; manifest: SessionManifest } | null =>
  listSessions().find(s => s.manifest.id === id) ?? null

/** Free bytes on the volume holding the recordings, or null if the OS will not say. */
export const freeBytes = async (): Promise<number | null> => {
  const root = recordingsRoot()
  try {
    mkdirSync(root, { recursive: true })
    const s = await statfs(root)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}
