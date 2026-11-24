import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject
} from 'node:crypto'
import { argon2idAsync } from '@noble/hashes/argon2.js'
import { formatDeviceId } from '@shared/utils/remote'

/*
 * Cryptographic building blocks of the Remote Desktop protocol. Only Node's
 * built-in crypto (BoringSSL in Electron) and @noble/hashes' audited Argon2id
 * (Electron's BoringSSL has no Argon2).
 *
 *   identity    Ed25519, one per installation; the device ID is derived from it
 *   key share   X25519, fresh per connection (forward secrecy)
 *   transport   AES-256-GCM, one key per direction, strict counters (channel.ts)
 *   password    Argon2id → verifier; proven with HMAC over the handshake
 */

export const PROTOCOL_LABEL = 'featured-remote-desktop/v1'

/** An installation's long-term identity. */
export interface LocalIdentity {
  id: string
  name: string
  os: string
  platform: 'darwin' | 'win32' | 'linux'
  /** Ed25519 public key, SPKI DER. */
  publicKey: Buffer
  privateKey: KeyObject
}

export const generateIdentityKeys = (): { publicKey: Buffer; privateKey: Buffer } => {
  const pair = generateKeyPairSync('ed25519')
  return {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }),
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' })
  }
}

export const privateKeyFromDer = (der: Buffer): KeyObject => createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })

const publicKeyFromDer = (der: Buffer): KeyObject => createPublicKey({ key: der, format: 'der', type: 'spki' })

/** Is this a well-formed Ed25519 SPKI public key? */
export const isEd25519PublicKey = (der: Buffer): boolean => {
  try {
    return publicKeyFromDer(der).asymmetricKeyType === 'ed25519'
  } catch {
    return false
  }
}

const keyNumber = (der: Buffer): bigint => createHash('sha256').update(der).digest().readBigUInt64BE(0)

/**
 * The 8-digit device ID: SHA-256 of the public key, first 8 bytes mod 10⁸.
 * Binding the ID to the key means a peer cannot simply claim an ID; the
 * first connection also pins the full key fingerprint (TOFU), because ~27 bits
 * alone could be brute-forced by a determined attacker.
 *
 * mod 10⁸ is the last 8 digits of the old mod-10⁹ ID, so every existing
 * computer keeps its number minus the first digit.
 */
export const deviceIdFromPublicKey = (der: Buffer): string => formatDeviceId((keyNumber(der) % 100_000_000n).toString())

/**
 * The ID builds up to 0.1.5 expect on the wire (WD-123-456-789). Sent in the
 * handshake and LAN announcements so an older copy of the app still accepts
 * this one; newer copies turn it into the 8-digit ID.
 */
export const legacyDeviceIdFromPublicKey = (der: Buffer): string => {
  const digits = (keyNumber(der) % 1_000_000_000n).toString().padStart(9, '0')
  return `WD-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}`
}

/** 128-bit fingerprint of a public key, as 8 groups of 4 hex digits. */
export const fingerprintOf = (der: Buffer): string =>
  createHash('sha256')
    .update(der)
    .digest('hex')
    .slice(0, 32)
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1 ')

export const signTranscript = (privateKey: KeyObject, transcript: Buffer): Buffer => sign(null, transcript, privateKey)

export const verifyTranscript = (publicKeyDer: Buffer, transcript: Buffer, signature: Buffer): boolean => {
  try {
    return verify(null, transcript, publicKeyFromDer(publicKeyDer), signature)
  } catch {
    return false
  }
}

// ── ephemeral key exchange ──────────────────────────────────────────────────

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

export interface Ephemeral {
  publicRaw: Buffer
  privateKey: KeyObject
}

export const generateEphemeral = (): Ephemeral => {
  const pair = generateKeyPairSync('x25519')
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' })
  return { publicRaw: spki.subarray(spki.length - 32), privateKey: pair.privateKey }
}

export const sharedSecret = (own: Ephemeral, peerRaw: Buffer): Buffer => {
  if (peerRaw.length !== 32) throw new Error('Bad key share.')
  const publicKey = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, peerRaw]), format: 'der', type: 'spki' })
  const secret = diffieHellman({ privateKey: own.privateKey, publicKey })
  // An all-zero result means a low-order point: refuse it.
  if (secret.every(b => b === 0)) throw new Error('Bad key share.')
  return secret
}

/** Hash of both hello frames, exactly as sent: what both sides sign and bind keys to. */
export const transcriptHash = (clientHello: Buffer, hostHello: Buffer): Buffer => {
  const len = (b: Buffer): Buffer => {
    const out = Buffer.alloc(4)
    out.writeUInt32BE(b.length)
    return out
  }
  return createHash('sha256').update(PROTOCOL_LABEL).update(len(clientHello)).update(clientHello).update(len(hostHello)).update(hostHello).digest()
}

export interface SessionKeys {
  clientToHost: Buffer
  hostToClient: Buffer
  /** 6 digits shown on both screens during an attended request. */
  verificationCode: string
}

export const deriveSessionKeys = (secret: Buffer, transcript: Buffer): SessionKeys => {
  const derive = (info: string, length = 32): Buffer => Buffer.from(hkdfSync('sha256', secret, transcript, `${PROTOCOL_LABEL} ${info}`, length))
  const sas = derive('verification', 4).readUInt32BE(0) % 1_000_000
  return {
    clientToHost: derive('c2h'),
    hostToClient: derive('h2c'),
    verificationCode: String(sas).padStart(6, '0').replace(/^(\d{3})(\d{3})$/, '$1 $2')
  }
}

// ── passwords ───────────────────────────────────────────────────────────────

export interface KdfParams {
  /** Iterations. */
  t: number
  /** Memory, KiB. */
  m: number
  /** Parallelism. */
  p: number
}

/** RFC 9106's second recommended option: 64 MiB, 3 passes (~0.5 s in Electron, paid by the connecting side). */
export const DEFAULT_KDF: KdfParams = { t: 3, m: 65_536, p: 1 }

/** A host cannot make a client burn unlimited CPU / memory. */
export const kdfParamsAcceptable = (p: KdfParams): boolean =>
  Number.isInteger(p.t) && p.t >= 1 && p.t <= 10 && Number.isInteger(p.m) && p.m >= 8 && p.m <= 262_144 && Number.isInteger(p.p) && p.p >= 1 && p.p <= 4

/** Argon2id(password, salt). The host keeps only this (encrypted at rest), never the password. */
export const passwordVerifier = (password: string, salt: Buffer, params: KdfParams = DEFAULT_KDF): Promise<Buffer> =>
  argon2idAsync(password.normalize('NFKC'), salt, { ...params, dkLen: 32, asyncTick: 25 }).then(bytes => Buffer.from(bytes))

/** What the client sends: proves it knows the password for *this* handshake (not replayable elsewhere). */
export const passwordProof = (verifier: Buffer, transcript: Buffer): Buffer =>
  createHmac('sha256', verifier).update(`${PROTOCOL_LABEL} password`).update(transcript).digest()

/** Proof for resuming a session after a dropped connection. */
export const resumeProof = (token: Buffer, transcript: Buffer): Buffer =>
  createHmac('sha256', token).update(`${PROTOCOL_LABEL} resume`).update(transcript).digest()

export const safeEqual = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b)

export const randomToken = (bytes = 32): Buffer => randomBytes(bytes)
