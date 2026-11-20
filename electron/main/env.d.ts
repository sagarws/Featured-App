/** Build-time env electron-vite inlines into the main process (VITE_* is shared with the window). */
interface ImportMetaEnv {
  /** TrackVid-BE base URL (no /api). Allowed in the window's Content-Security-Policy. */
  readonly VITE_APP_BASE_URL?: string
  /** Google OAuth client (the one share-chat uses) for Drive: Screenshots upload and File Share. */
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string
  /** Must be an Authorized redirect URI of that client. Default http://localhost:3000/oauth2callback. */
  readonly MAIN_VITE_GOOGLE_REDIRECT_URI?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
