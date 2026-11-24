import { describe, expect, it } from 'vitest'
import { compareVersions, directDownloadUrl, parseUpdateInfo } from '@shared/utils/version'
import { updateFeedFor } from '@shared/constants/updates'

describe('compareVersions', () => {
  it('orders by each number, not as text', () => {
    expect(compareVersions('0.1.10', '0.1.4')).toBe(1)
    expect(compareVersions('0.1.4', '0.2.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
  })

  it('treats missing parts as zero and ignores a leading v', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0)
  })

  it('puts a pre-release before its release', () => {
    expect(compareVersions('1.2.0-beta', '1.2.0')).toBe(-1)
    expect(compareVersions('1.2.0', '1.2.0-beta')).toBe(1)
    expect(compareVersions('1.2.0-beta.2', '1.2.0-beta.1')).toBe(1)
  })
})

describe('parseUpdateInfo', () => {
  it('accepts the server answer and drops other fields', () => {
    expect(
      parseUpdateInfo({ softwareName: 'Featured-App-x64', version: 'v0.2.0', link: 'https://x.test/a.dmg', updatedAt: 'x' })
    ).toEqual({ softwareName: 'Featured-App-x64', version: '0.2.0', link: 'https://x.test/a.dmg' })
  })

  it('refuses links the app must not open', () => {
    expect(parseUpdateInfo({ version: '1.0.0', link: 'file:///etc/passwd' })).toBeNull()
    expect(parseUpdateInfo({ version: '1.0.0', link: 'javascript:alert(1)' })).toBeNull()
    expect(parseUpdateInfo({ version: '1.0.0', link: 'not a url' })).toBeNull()
    expect(parseUpdateInfo({ version: '1.0.0', link: 'http://x.test/a.exe' })).toBeNull()
  })

  it('refuses a missing or odd version and non-objects', () => {
    expect(parseUpdateInfo({ link: 'https://x.test' })).toBeNull()
    expect(parseUpdateInfo({ version: 'latest', link: 'https://x.test' })).toBeNull()
    expect(parseUpdateInfo(null)).toBeNull()
    expect(parseUpdateInfo({ error: 'not found' })).toBeNull()
  })
})

describe('directDownloadUrl', () => {
  it('turns a Drive share page into the file download, past the virus-scan page', () => {
    expect(directDownloadUrl('https://drive.google.com/file/d/1OBsJD6fGhu-SzXE0gHedS3mlZUVD5yUq/view?usp=drivesdk')).toBe(
      'https://drive.usercontent.google.com/download?id=1OBsJD6fGhu-SzXE0gHedS3mlZUVD5yUq&export=download&confirm=t'
    )
    expect(directDownloadUrl('https://drive.google.com/open?id=1OBsJD6fGhu-SzXE0gHedS3mlZUVD5yUq')).toContain(
      'id=1OBsJD6fGhu-SzXE0gHedS3mlZUVD5yUq'
    )
  })

  it('leaves any other link alone', () => {
    expect(directDownloadUrl('https://cdn.test/Featured-App-x64-setup.exe')).toBe('https://cdn.test/Featured-App-x64-setup.exe')
  })
})

describe('updateFeedFor', () => {
  it('has a feed for Windows 64-bit and Apple Silicon Macs only, for now', () => {
    expect(updateFeedFor('win32', 'x64')).toMatchObject({ softwareName: 'Featured-App-x64', installer: 'exe' })
    expect(updateFeedFor('darwin', 'arm64')).toMatchObject({ softwareName: 'Featured-App-arm64', installer: 'dmg' })
    expect(updateFeedFor('darwin', 'arm64')?.url).toBe('https://check-otp-khaki.vercel.app/api/software/Featured-App-arm64')
    expect(updateFeedFor('win32', 'ia32')).toBeNull()
    expect(updateFeedFor('darwin', 'x64')).toBeNull()
    expect(updateFeedFor('linux', 'x64')).toBeNull()
  })
})
