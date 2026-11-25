import { describe, expect, it } from 'vitest'
import {
  acceleratorFromKeys,
  chooseFormat,
  chooseToolbarLayout,
  DEFAULT_HOTKEYS,
  encodeKey,
  formatAccelerator,
  isAccelerator,
  s3ObjectKey,
  sanitiseScreenshotSettings,
  screenshotFileName,
  EDITOR_TOOLBAR_GAP,
  uniqueFileName,
  uploadProblem,
  valueAtPath
} from '../shared/utils/screenshot'
import { linkFromResponse } from '../electron/main/screenshot/upload/api'
import { authorizationHeader, objectLocation, presignedGetUrl } from '../electron/main/screenshot/upload/s3'

const key = (code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: '',
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

describe('screenshot settings', () => {
  it('fills defaults and drops junk', () => {
    const s = sanitiseScreenshotSettings({ saveFormat: 'gif', thumbnailTimeout: 7, backgroundColor: 'red', hotkeys: { area: 'Nope+Q', fullscreen: '' } })
    expect(s.saveFormat).toBe('png')
    expect(s.thumbnailTimeout).toBe(5)
    expect(s.backgroundColor).toBe('#4353FF')
    expect(s.hotkeys.area).toBe(DEFAULT_HOTKEYS.area)
    expect(s.hotkeys.fullscreen).toBe('')
    expect(s.upload.provider).toBe('none')
  })

  it('cleans upload settings', () => {
    const s = sanitiseScreenshotSettings({
      upload: {
        provider: 'api',
        s3: { endpoint: 'https://x.r2.cloudflarestorage.com///', keyPrefix: '/shots/', presignHours: 1000 },
        api: { headers: [{ name: 'Authorization', value: 'Bearer a\r\nX-Evil: 1' }, { name: 'bad name', value: 'x' }] }
      }
    })
    expect(s.upload.s3.endpoint).toBe('https://x.r2.cloudflarestorage.com')
    expect(s.upload.s3.keyPrefix).toBe('shots/')
    expect(s.upload.s3.presignHours).toBe(168)
    // No header injection, no invalid names.
    expect(s.upload.api.headers).toEqual([{ name: 'Authorization', value: 'Bearer aX-Evil: 1' }])
  })

  it('says what is missing before an upload', () => {
    const s = sanitiseScreenshotSettings(null).upload
    expect(uploadProblem(s)).toMatch(/Choose where/)
    expect(uploadProblem({ ...s, provider: 'api' })).toMatch(/URL/)
    expect(uploadProblem({ ...s, provider: 'api', api: { ...s.api, url: 'https://a.example/upload' } })).toBeNull()
    expect(uploadProblem({ ...s, provider: 'google-drive' })).toMatch(/Connect/)
    expect(uploadProblem({ ...s, provider: 'google-drive', google: { ...s.google, account: { email: 'a@b.c', name: 'A', picture: '' } } })).toBeNull()
    // The account never comes from saved settings.
    expect(sanitiseScreenshotSettings({ upload: { google: { account: { email: 'x@y.z' }, folderId: 'abc_-1' } } }).upload.google).toEqual({ folderId: 'abc_-1', folderName: '', account: null })
  })
})

describe('shortcuts', () => {
  it('validates accelerators', () => {
    expect(isAccelerator('CommandOrControl+Shift+2')).toBe(true)
    expect(isAccelerator('F5')).toBe(true)
    expect(isAccelerator('PrintScreen')).toBe(true)
    expect(isAccelerator('A')).toBe(false)
    expect(isAccelerator('Shift+Shift+A')).toBe(false)
    expect(isAccelerator('Hyper+A')).toBe(false)
  })

  it('records from physical keys', () => {
    expect(acceleratorFromKeys(key('Digit2', { metaKey: true, shiftKey: true }), true)).toBe('Shift+Command+2')
    expect(acceleratorFromKeys(key('KeyX', { ctrlKey: true, altKey: true }), false)).toBe('Control+Alt+X')
    expect(acceleratorFromKeys(key('F12'), false)).toBe('F12')
    expect(acceleratorFromKeys(key('KeyA'), false)).toBeNull()
    expect(acceleratorFromKeys(key('ShiftLeft', { shiftKey: true }), false)).toBeNull()
  })

  it('formats for each platform', () => {
    expect(formatAccelerator('Shift+Command+2', true)).toBe('⇧⌘2')
    expect(formatAccelerator('CommandOrControl+Shift+1', false)).toBe('Ctrl+Shift+1')
    expect(formatAccelerator('Control+Alt+Return', true)).toBe('⌃⌥↩')
  })
})

describe('files', () => {
  it('names and de-duplicates', () => {
    const date = new Date(2026, 10, 20, 9, 4, 5)
    expect(screenshotFileName(date, 'png')).toBe('Screenshot 2026-11-20 at 09.04.05.png')
    const taken = new Set(['a.png', 'a 2.png'])
    expect(uniqueFileName('a.png', n => taken.has(n))).toBe('a 3.png')
    expect(uniqueFileName('b.png', n => taken.has(n))).toBe('b.png')
  })

  it('picks a format', () => {
    expect(chooseFormat('png', 5_000_000, 100)).toBe('png')
    expect(chooseFormat('jpeg', 100, 5_000_000)).toBe('jpeg')
    expect(chooseFormat('auto', 100_000, 10_000)).toBe('png') // small: always PNG
    expect(chooseFormat('auto', 4_000_000, 900_000)).toBe('jpeg') // photo-like
    expect(chooseFormat('auto', 2_000_000, 1_500_000)).toBe('png') // UI: JPEG not worth it
  })
})

describe('upload API response', () => {
  it('finds the link', () => {
    expect(valueAtPath({ data: { files: [{ url: 'x' }] } }, 'data.files.0.url')).toBe('x')
    expect(linkFromResponse('{"url":"https://cdn.example/a.png"}', 'url')).toBe('https://cdn.example/a.png')
    expect(linkFromResponse('{"data":{"link":"https://i.example/b"}}', 'data.link')).toBe('https://i.example/b')
    expect(linkFromResponse('  https://i.example/c.png\n', 'url')).toBe('https://i.example/c.png')
    expect(() => linkFromResponse('{"ok":true}', 'url')).toThrow(/without a link at "url"/)
    expect(() => linkFromResponse('{"url":"javascript:alert(1)"}', 'url')).toThrow()
  })
})

/*
 * Signature Version 4 against the worked examples in the Amazon S3 API
 * reference ("Signature Calculations for the Authorization Header" and
 * "Authenticating Requests: Using Query Parameters").
 */
describe('S3 signing', () => {
  const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' }
  const date = new Date(Date.UTC(2013, 4, 24, 0, 0, 0))

  it('signs a PUT like the AWS example', () => {
    const payloadHash = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072'
    const header = authorizationHeader(
      creds,
      {
        method: 'PUT',
        path: `/${encodeKey('test$file.text')}`,
        headers: {
          Host: 'examplebucket.s3.amazonaws.com',
          Date: 'Fri, 24 May 2013 00:00:00 GMT',
          'x-amz-date': '20130524T000000Z',
          'x-amz-storage-class': 'REDUCED_REDUNDANCY',
          'x-amz-content-sha256': payloadHash
        },
        payloadHash
      },
      date
    )
    expect(header).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'
    )
  })

  it('signs a GET like the AWS example', () => {
    const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const header = authorizationHeader(
      creds,
      { method: 'GET', path: '/test.txt', headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': payloadHash, 'x-amz-date': '20130524T000000Z' }, payloadHash },
      date
    )
    expect(header.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')).toBe(true)
  })

  it('presigns like the AWS example', () => {
    const url = presignedGetUrl(creds, 'https://examplebucket.s3.amazonaws.com', 'examplebucket.s3.amazonaws.com', '/test.txt', 86400, date)
    expect(url).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
    expect(url).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request')
  })

  it('addresses objects per service', () => {
    const base = sanitiseScreenshotSettings(null).upload.s3
    const key = s3ObjectKey('shots/', 'Screenshot 1.png')
    expect(key).toBe('shots/Screenshot 1.png')
    expect(objectLocation({ ...base, bucket: 'pics', region: 'eu-west-1' }, key)).toEqual({
      origin: 'https://pics.s3.eu-west-1.amazonaws.com',
      host: 'pics.s3.eu-west-1.amazonaws.com',
      path: '/shots/Screenshot%201.png',
      region: 'eu-west-1'
    })
    expect(objectLocation({ ...base, bucket: 'my.pics', region: 'auto' }, 'a.png').host).toBe('s3.us-east-1.amazonaws.com')
    expect(objectLocation({ ...base, service: 'other', endpoint: 'https://acc.r2.cloudflarestorage.com', bucket: 'pics', region: 'auto' }, 'a.png')).toEqual({
      origin: 'https://acc.r2.cloudflarestorage.com',
      host: 'acc.r2.cloudflarestorage.com',
      path: '/pics/a.png',
      region: 'auto'
    })
  })
})

describe('editor toolbar layout', () => {
  it('keeps one row until measured', () => {
    expect(chooseToolbarLayout(200, 0, 0)).toBe('row')
    expect(chooseToolbarLayout(200, 600, 0)).toBe('row')
  })

  it('keeps one row when tools and actions fit', () => {
    expect(chooseToolbarLayout(600 + 250 + EDITOR_TOOLBAR_GAP, 600, 250)).toBe('row')
    expect(chooseToolbarLayout(1400, 600, 250)).toBe('row')
  })

  it('splits when the window is too narrow for the row', () => {
    expect(chooseToolbarLayout(600 + 250 + EDITOR_TOOLBAR_GAP - 1, 600, 250)).toBe('split')
    expect(chooseToolbarLayout(664, 1000, 320)).toBe('split')
  })
})
