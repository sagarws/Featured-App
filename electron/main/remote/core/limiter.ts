/**
 * Failed-password throttling. Each key (the peer's address and its device ID)
 * gets a few free attempts, then an exponentially growing lockout; on top of
 * that a global ceiling stops a spread-out guessing attack.
 */
export interface LimiterOptions {
  freeAttempts: number
  baseLockMs: number
  maxLockMs: number
  /** Failures across all peers per minute before everyone waits a minute. */
  globalPerMinute: number
}

const DEFAULTS: LimiterOptions = { freeAttempts: 3, baseLockMs: 30_000, maxLockMs: 15 * 60_000, globalPerMinute: 20 }

export class AuthLimiter {
  private entries = new Map<string, { failures: number; lockedUntil: number; lastFailure: number }>()
  private recent: number[] = []
  private globalLockedUntil = 0
  private readonly options: LimiterOptions

  constructor(
    private readonly now: () => number = Date.now,
    options: Partial<LimiterOptions> = {}
  ) {
    this.options = { ...DEFAULTS, ...options }
  }

  /** Milliseconds until any of `keys` may try again; 0 = go ahead. */
  retryAfter(keys: string[]): number {
    const now = this.now()
    let wait = Math.max(0, this.globalLockedUntil - now)
    for (const key of keys) {
      const entry = this.entries.get(key)
      if (entry) wait = Math.max(wait, entry.lockedUntil - now)
    }
    return Math.max(0, wait)
  }

  failure(keys: string[]): void {
    const now = this.now()
    for (const key of keys) {
      const entry = this.entries.get(key) ?? { failures: 0, lockedUntil: 0, lastFailure: 0 }
      // A day without failures starts the count over.
      if (now - entry.lastFailure > 24 * 3600_000) entry.failures = 0
      entry.failures++
      entry.lastFailure = now
      const over = entry.failures - this.options.freeAttempts
      if (over >= 0) entry.lockedUntil = now + Math.min(this.options.maxLockMs, this.options.baseLockMs * 2 ** over)
      this.entries.set(key, entry)
    }
    this.recent = this.recent.filter(t => now - t < 60_000)
    this.recent.push(now)
    if (this.recent.length >= this.options.globalPerMinute) this.globalLockedUntil = now + 60_000
    if (this.entries.size > 10_000) this.prune(now)
  }

  success(keys: string[]): void {
    for (const key of keys) this.entries.delete(key)
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) if (entry.lockedUntil < now && now - entry.lastFailure > 3600_000) this.entries.delete(key)
  }
}

/** At most `limit` events per `windowMs` per key (incoming request pop-ups). */
export class WindowCounter {
  private hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Records a hit; false if the key is over its limit (the hit is not recorded then). */
  hit(key: string): boolean {
    const now = this.now()
    const list = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs)
    if (list.length >= this.limit) {
      this.hits.set(key, list)
      return false
    }
    list.push(now)
    this.hits.set(key, list)
    return true
  }
}
