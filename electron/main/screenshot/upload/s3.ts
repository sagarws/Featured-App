import { createHash, createHmac } from 'node:crypto'
import type { S3Config } from '@shared/types/screenshot'
import { encodeKey, s3ObjectKey } from '@shared/utils/screenshot'

/*
 * Amazon S3 and S3-compatible storage (Cloudflare R2, Backblaze B2, MinIO,
 * Wasabi, DigitalOcean Spaces …) with AWS Signature Version 4, signed here so
 * the app does not carry the AWS SDK. Checked against AWS's documented
 * examples in tests/screenshot.test.ts.
 */

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest()

/** 20130524T000000Z */
export const amzDate = (date: Date): string => date.toISOString().replace(/[:-]|\.\d{3}/g, '')

const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

const canonicalQuery = (query: Record<string, string>): string =>
  Object.keys(query)
    .sort()
    .map(key => `${rfc3986(key)}=${rfc3986(query[key] ?? '')}`)
    .join('&')

interface Credentials {
  accessKeyId: string
  secretAccessKey: string
  region: string
  service?: string
}

const scopeFor = (date: Date, region: string, service: string): string => `${amzDate(date).slice(0, 8)}/${region}/${service}/aws4_request`

const signingKey = (secret: string, date: Date, region: string, service: string): Buffer =>
  hmac(hmac(hmac(hmac(`AWS4${secret}`, amzDate(date).slice(0, 8)), region), service), 'aws4_request')

const signature = (creds: Credentials, date: Date, canonicalRequest: string): string => {
  const service = creds.service ?? 's3'
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate(date), scopeFor(date, creds.region, service), sha256Hex(canonicalRequest)].join('\n')
  return createHmac('sha256', signingKey(creds.secretAccessKey, date, creds.region, service)).update(stringToSign).digest('hex')
}

/**
 * The Authorization header for a request. `headers` must already hold every
 * header to be signed, including host, x-amz-date and x-amz-content-sha256.
 * `path` is the already-encoded path ("/bucket/my%20file.png").
 */
export const authorizationHeader = (
  creds: Credentials,
  request: { method: string; path: string; query?: Record<string, string>; headers: Record<string, string>; payloadHash: string },
  date: Date
): string => {
  const names = Object.keys(request.headers)
    .map(name => name.toLowerCase())
    .sort()
  const lower = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')]))
  const canonicalRequest = [
    request.method,
    request.path,
    canonicalQuery(request.query ?? {}),
    names.map(name => `${name}:${lower[name]}\n`).join(''),
    names.join(';'),
    request.payloadHash
  ].join('\n')
  const scope = scopeFor(date, creds.region, creds.service ?? 's3')
  return `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope},SignedHeaders=${names.join(';')},Signature=${signature(creds, date, canonicalRequest)}`
}

/** A presigned GET link, valid for `expiresSeconds` (S3 allows up to 7 days). */
export const presignedGetUrl = (creds: Credentials, origin: string, host: string, path: string, expiresSeconds: number, date: Date): string => {
  const service = creds.service ?? 's3'
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scopeFor(date, creds.region, service)}`,
    'X-Amz-Date': amzDate(date),
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host'
  }
  const canonicalRequest = ['GET', path, canonicalQuery(query), `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  return `${origin}${path}?${canonicalQuery({ ...query, 'X-Amz-Signature': signature(creds, date, canonicalRequest) })}`
}

/** Where an object lives: virtual-hosted on AWS, path-style for other services (and dotted bucket names). */
export const objectLocation = (config: S3Config, key: string): { origin: string; host: string; path: string; region: string } => {
  const region = config.service === 'aws' && (!config.region || config.region === 'auto') ? 'us-east-1' : config.region || 'auto'
  const encoded = encodeKey(key)
  if (config.service === 'other') {
    const endpoint = new URL(config.endpoint)
    const base = endpoint.pathname.replace(/\/+$/, '')
    return { origin: endpoint.origin, host: endpoint.host, path: `${base}/${encodeKey(config.bucket)}/${encoded}`, region }
  }
  if (config.bucket.includes('.')) {
    const host = `s3.${region}.amazonaws.com`
    return { origin: `https://${host}`, host, path: `/${encodeKey(config.bucket)}/${encoded}`, region }
  }
  const host = `${config.bucket}.s3.${region}.amazonaws.com`
  return { origin: `https://${host}`, host, path: `/${encoded}`, region }
}

const s3Error = async (response: Response): Promise<Error> => {
  const body = await response.text().catch(() => '')
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1]
  const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1]
  const hint =
    code === 'SignatureDoesNotMatch' ? ' Check the secret key and region.'
    : code === 'InvalidAccessKeyId' ? ' Check the access key.'
    : code === 'NoSuchBucket' ? ' Check the bucket name.'
    : code === 'AccessDenied' ? ' The key is not allowed to write to this bucket.'
    : ''
  return new Error(`S3 answered ${response.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}.${hint}`)
}

const send = async (config: S3Config, method: 'PUT' | 'DELETE', key: string, body: Uint8Array | null, contentType: string | null): Promise<void> => {
  const { origin, host, path, region } = objectLocation(config, key)
  const date = new Date()
  const payloadHash = sha256Hex(body ?? '')
  const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(date) }
  if (contentType) headers['content-type'] = contentType
  const authorization = authorizationHeader({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region }, { method, path, headers, payloadHash }, date)
  // fetch sets Host itself (and refuses it as a header); it was signed above.
  const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'))
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...sent, authorization },
    ...(body ? { body: Buffer.from(body) } : {}),
    signal: AbortSignal.timeout(60_000)
  })
  if (!response.ok) throw await s3Error(response)
}

/** Upload; returns the link to share (null when link sharing is off). */
export const uploadToS3 = async (config: S3Config, fileName: string, bytes: Uint8Array, contentType: string): Promise<string | null> => {
  const key = s3ObjectKey(config.keyPrefix, fileName)
  await send(config, 'PUT', key, bytes, contentType)
  const { origin, host, path, region } = objectLocation(config, key)
  switch (config.linkSharing) {
    case 'none':
      return null
    case 'presigned':
      return presignedGetUrl({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region }, origin, host, path, config.presignHours * 3600, new Date())
    case 'public':
      return config.publicBaseUrl ? `${config.publicBaseUrl}/${encodeKey(key)}` : `${origin}${path}`
  }
}

/** Write and delete a tiny object, so a wrong key, bucket or region shows up before the first screenshot. */
export const testS3 = async (config: S3Config): Promise<string> => {
  const key = s3ObjectKey(config.keyPrefix, `.featured-app-test-${Date.now()}.txt`)
  await send(config, 'PUT', key, new TextEncoder().encode('Featured App connection test'), 'text/plain')
  // Some keys may write but not delete; the write is what matters.
  await send(config, 'DELETE', key, null, null).catch(() => undefined)
  return `Connected to bucket "${config.bucket}".`
}
