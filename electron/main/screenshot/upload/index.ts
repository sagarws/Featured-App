import type { ScreenshotSettings } from '@shared/types/screenshot'
import { uploadProblem } from '@shared/utils/screenshot'
import { uploadToApi, type UploadFile } from './api'
import { testGoogleDrive, uploadToGoogleDrive } from './google'
import { testS3, uploadToS3 } from './s3'

export type { UploadFile } from './api'

/** Upload with the configured service; the link to share, or null when the service gives none. */
export const uploadImage = async (settings: ScreenshotSettings, file: UploadFile): Promise<string | null> => {
  const upload = settings.upload
  const problem = uploadProblem(upload)
  if (problem) throw new Error(problem)
  switch (upload.provider) {
    case 's3':
      return uploadToS3(upload.s3, file.fileName, file.bytes, file.mimeType)
    case 'google-drive':
      return uploadToGoogleDrive(upload.google, file.fileName, file.bytes, file.mimeType)
    case 'api':
      return uploadToApi(upload.api, file)
    case 'none':
      return null
  }
}

// 1×1 transparent PNG, for the API test.
const TEST_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/** Check the settings against the real service; a line to show on success. */
export const testUpload = async (settings: ScreenshotSettings): Promise<string> => {
  const upload = settings.upload
  const problem = uploadProblem(upload)
  if (problem) throw new Error(problem)
  switch (upload.provider) {
    case 's3':
      return testS3(upload.s3)
    case 'google-drive':
      return testGoogleDrive(upload.google)
    case 'api': {
      const link = await uploadToApi(upload.api, {
        fileName: 'featured-app-test.png',
        mimeType: 'image/png',
        bytes: TEST_PNG,
        width: 1,
        height: 1,
        capturedAt: new Date().toISOString()
      })
      return `Your API answered with ${link}`
    }
    case 'none':
      return 'Uploading is off.'
  }
}
