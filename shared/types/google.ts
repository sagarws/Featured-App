/*
 * The connected Google account and its Drive, shared by Screenshots
 * (upload) and File Share. One account per computer user — never a shared
 * or company Drive. See electron/main/google.
 */

export interface GoogleAccount {
  email: string
  name: string
  /** Avatar URL from Google, '' when none. */
  picture: string
}

export interface GoogleStatus {
  /** False when the build has no OAuth client (MAIN_VITE_GOOGLE_CLIENT_ID / _SECRET). */
  configured: boolean
  account: GoogleAccount | null
  /** A browser sign-in is waiting for the user. */
  connecting: boolean
  /** Where Google sends the browser back, e.g. http://localhost:3000/oauth2callback. */
  redirectUri: string
}

export interface DriveFolder {
  id: string
  name: string
  /** A top-level folder in My Drive. */
  root?: boolean
  children: DriveFolder[]
}

export interface DriveFile {
  id: string
  name: string
  mime: string
  size: number
  description: string
  /** ms since epoch. */
  createdAt: number
  /** Drive's web link (works for anyone once shared). */
  link: string
  /** "Anyone with the link" can view it. */
  shared: boolean
  hasThumb: boolean
}

export type UploadJobStatus = 'uploading' | 'done' | 'failed' | 'cancelled'

export interface UploadJob {
  id: string
  name: string
  size: number
  sent: number
  folderId: string
  status: UploadJobStatus
  error?: string
  file?: DriveFile
}
