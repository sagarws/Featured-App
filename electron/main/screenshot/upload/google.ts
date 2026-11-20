import type { GoogleDriveConfig } from '@shared/types/screenshot'
import { APP_FOLDER_NAME, ensureAppFolder, shareFile, uploadFile } from '../../google/drive'

/*
 * Screenshots to the connected Google Drive (the same account and Drive
 * client File Share uses — see electron/main/google). Each upload goes into
 * the chosen folder and is shared "anyone with the link can view", and that
 * link is what gets copied.
 */

const target = async (config: GoogleDriveConfig): Promise<string> => config.folderId || (await ensureAppFolder())

export const uploadToGoogleDrive = async (config: GoogleDriveConfig, fileName: string, bytes: Uint8Array, contentType: string): Promise<string> => {
  const file = await uploadFile(await target(config), { name: fileName, mime: contentType, size: bytes.length, bytes, description: 'Screenshot from Featured App' })
  return shareFile(file.id)
}

export const testGoogleDrive = async (config: GoogleDriveConfig): Promise<string> => {
  await target(config)
  return `Connected as ${config.account?.email ?? 'your Google account'}. Screenshots go to “${config.folderName || APP_FOLDER_NAME}” and get a public link.`
}
