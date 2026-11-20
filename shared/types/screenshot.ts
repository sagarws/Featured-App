/*
 * Screenshots: capture, annotate, save, copy and upload. See
 * electron/main/screenshot for the main-process side and
 * electron/renderer/screenshot for the page, editor and overlays.
 */

/** What a global shortcut (or a tray / page button) does. */
export type ScreenshotAction = 'fullscreen' | 'area' | 'repeatArea' | 'window' | 'activeWindow' | 'showApp'

/** How a captured window is framed. */
export type WindowBackground = 'backdrop' | 'transparent' | 'solid' | 'trim'

/** PNG always, JPEG always, or whichever suits the picture (PNG for UI, JPEG for photos). */
export type SaveFormat = 'png' | 'jpeg' | 'auto'

/** After an area capture: a small floating preview, or straight into the editor. */
export type AfterAreaShow = 'thumbnail' | 'editor'

/** Seconds before the floating preview hides itself; 0 = only with its close button. */
export type ThumbnailTimeout = 0 | 5 | 10 | 30

export type ConfirmationStyle = 'notification' | 'none'

export type UploadProvider = 'none' | 's3' | 'google-drive' | 'api'

export type S3LinkSharing = 'public' | 'presigned' | 'none'

export interface S3Config {
  accessKeyId: string
  /** Stored encrypted (safeStorage). */
  secretAccessKey: string
  bucket: string
  /** Amazon S3, or any S3-compatible service (Cloudflare R2, Backblaze B2, MinIO, …). */
  service: 'aws' | 'other'
  /** e.g. us-east-1. "auto" for Cloudflare R2. */
  region: string
  /** For "other": https://<account>.r2.cloudflarestorage.com, https://s3.us-west-004.backblazeb2.com, … */
  endpoint: string
  /** Folder inside the bucket, e.g. "screenshots/". */
  keyPrefix: string
  linkSharing: S3LinkSharing
  /** For "public": https://cdn.example.com or https://pub-xxxx.r2.dev — the object key is appended. */
  publicBaseUrl: string
  /** For "presigned": 1 h – 168 h (S3's limit is 7 days). */
  presignHours: number
}

export interface GoogleDriveConfig {
  /** From a Google Cloud OAuth client of type "Desktop app". */
  clientId: string
  /** Stored encrypted. Google treats a desktop client's secret as non-confidential. */
  clientSecret: string
  /** Folder in My Drive the screenshots go into (created on first upload). */
  folderName: string
  /** Give "Anyone with the link can view", so the copied link works for others. */
  makePublic: boolean
  /** The connected account, null when not connected. Set by the main process only. */
  account: { email: string; name: string } | null
}

export interface ApiHeader {
  name: string
  value: string
}

export interface ApiConfig {
  url: string
  method: 'POST' | 'PUT'
  /** multipart/form-data with the file, or application/json with the file as base64. */
  bodyType: 'multipart' | 'json'
  /** Form field / JSON key that carries the image. */
  fileField: string
  /** Stored encrypted — usually holds an Authorization token. */
  headers: ApiHeader[]
  /** Where the link is in the JSON response, dot path: "url", "data.link", "files.0.url". */
  urlPath: string
}

export interface UploadSettings {
  provider: UploadProvider
  /** Copy the link to the clipboard when an upload finishes. */
  copyLink: boolean
  s3: S3Config
  google: GoogleDriveConfig
  api: ApiConfig
}

export type ScreenshotHotkeys = Record<ScreenshotAction, string>

export interface ScreenshotSettings {
  /** null = <Pictures>/Featured App Screenshots. */
  folder: string | null
  saveFormat: SaveFormat
  /** Save Retina (2×) captures at 1× size. */
  downscaleRetina: boolean
  windowBackground: WindowBackground
  /** For the "solid" window background, #RRGGBB. */
  backgroundColor: string

  /** After a capture: show it (editor or thumbnail), copy it, save it, upload it. */
  afterShow: boolean
  afterCopy: boolean
  afterSave: boolean
  afterUpload: boolean
  afterAreaShow: AfterAreaShow
  thumbnailTimeout: ThumbnailTimeout

  /** Electron accelerators, '' = none. */
  hotkeys: ScreenshotHotkeys

  /** Menu-bar / tray icon off. The app is then reached by launching it again. */
  hideTrayIcon: boolean
  /** Editor windows float above other windows. */
  editorAlwaysOnTop: boolean
  /** Open the editor at 100% when the picture fits on screen. */
  preferActualSize: boolean
  /** What Esc does to the picture before it closes the editor. */
  escCopy: boolean
  escSave: boolean
  confirmation: ConfirmationStyle

  upload: UploadSettings
}

/** One picture held by the main process while a window shows it. */
export interface CaptureInfo {
  id: string
  width: number
  height: number
  /** Device pixels per CSS px on the display it came from (2 on Retina). */
  scaleFactor: number
  kind: 'fullscreen' | 'area' | 'window' | 'file'
  createdAt: string
  /** Where it was saved, once saved (or the file it was opened from). */
  savedPath: string | null
  /** The upload link, once uploaded. */
  link: string | null
}

export interface CaptureImage extends CaptureInfo {
  /** Lossless PNG bytes. */
  png: Uint8Array
}

/** A file in the screenshots folder, for the page's Recent list. */
export interface ScreenshotFile {
  path: string
  name: string
  size: number
  modifiedAt: string
  /** Small JPEG data: URL. */
  thumbnail: string
}

export interface HotkeyStatus {
  action: ScreenshotAction
  accelerator: string
  /** False when the OS or another app already owns the shortcut. */
  registered: boolean
}

export interface ScreenshotEnvironment {
  platform: 'darwin' | 'win32' | 'linux'
  folder: string
  /** macOS Screen Recording permission. */
  screenPermission: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  /** False when the OS cannot encrypt saved keys (some Linux setups): they are stored as plain text. */
  encryption: boolean
  hotkeys: HotkeyStatus[]
  /** Login item (shared with the app's Settings page). */
  openAtLogin: boolean
  packaged: boolean
}

/** What the editor / thumbnail / page asks the main process to do with a picture. */
export type ExportAction = 'copy' | 'save' | 'saveAs' | 'upload' | 'pin'

export interface ExportResult {
  /** The file written, for save / saveAs. */
  path?: string
  /** The link, for upload. */
  link?: string
}

/** A rectangle picked on the area overlay, in CSS px (= DIP) of that display. */
export interface AreaPick {
  displayId: string
  x: number
  y: number
  width: number
  height: number
}

/** One window offered by the window picker (Windows / Linux). */
export interface WindowChoice {
  id: string
  name: string
  thumbnail: string
  appIcon: string | null
}
