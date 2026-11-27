import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { sanitiseFeatureAccess, type FeatureAccess, type SidebarFeature } from '@shared/constants/sidebarFeatures'
import { readDurableJson, writeDurableJson } from './durableJson'
import { logger } from './logger'

/**
 * Which sidebar tabs this computer may use, as JSON in the OS app-data folder
 * (feature-access.json). Defaults: shared/constants/sidebarFeatures.json.
 * Changing a value needs the access password, MAIN_VITE_FEATURE_ACCESS_PASSWORD
 * in .env (inlined at build time); it is checked here, never in the window.
 */

let cached: FeatureAccess | null = null

const filePath = (): string => join(app.getPath('userData'), 'feature-access.json')

export const getFeatureAccess = (): FeatureAccess => {
  if (cached) return cached
  try {
    cached = sanitiseFeatureAccess(readDurableJson(filePath()))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('feature-access.json unreadable, using defaults', error)
    cached = sanitiseFeatureAccess(null)
  }
  return cached
}

export const setFeatureAccess = (id: SidebarFeature, enabled: boolean): FeatureAccess => {
  const next = { ...getFeatureAccess(), [id]: enabled }
  const path = filePath()
  mkdirSync(dirname(path), { recursive: true })
  writeDurableJson(path, next)
  cached = next
  return next
}

const accessPassword = (): string => import.meta.env.MAIN_VITE_FEATURE_ACCESS_PASSWORD || process.env['FEATURE_ACCESS_PASSWORD'] || ''

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

// Slow down guessing: after 5 wrong passwords, refuse for 30 s.
const MAX_FAILURES = 5
const LOCKOUT_MS = 30_000
let failures = 0
let lockedUntil = 0

export type PasswordCheck = { ok: true } | { ok: false; error: string }

export const checkAccessPassword = (password: unknown): PasswordCheck => {
  const expected = accessPassword()
  if (!expected) return { ok: false, error: 'No access password is set in this build (MAIN_VITE_FEATURE_ACCESS_PASSWORD).' }
  const now = Date.now()
  if (now < lockedUntil) return { ok: false, error: `Too many attempts. Try again in ${Math.ceil((lockedUntil - now) / 1000)} s.` }
  if (typeof password === 'string' && password.length < 256 && timingSafeEqual(digest(password), digest(expected))) {
    failures = 0
    return { ok: true }
  }
  failures += 1
  if (failures >= MAX_FAILURES) {
    failures = 0
    lockedUntil = now + LOCKOUT_MS
    logger.warn('Feature access: too many wrong passwords, locked for 30 s')
  }
  return { ok: false, error: 'Wrong password.' }
}
