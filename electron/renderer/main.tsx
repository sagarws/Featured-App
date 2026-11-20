/*
 * One page, several windows. The hash picks what this window is:
 *
 *   (none)    the app
 *   #engine   the recorder's hidden capture window (no UI)
 *   #toolbar  floating recording controls
 *   #region   region-selection overlay (one per display)
 *   #border   frame around the recorded region
 *   #camera   webcam bubble over a screen recording
 *   #shot-*   screenshot windows: area overlay, editor, thumbnail, pin,
 *             window picker (see screenshot/windows/mountShot.tsx)
 *   #rd-*     remote desktop: viewer, hidden host capture, host bar,
 *             incoming request (see remote/windows/mountRemote.tsx)
 *
 * Each loads only its own code: the overlays do not pull in the app, its
 * stylesheet (they must stay transparent) or Scan & Pack.
 */
const route = window.location.hash.replace(/^#/, '').split('?')[0] ?? ''

if (route === 'engine') {
  void import('./recorder/engine/engine').then(m => m.runEngine())
} else if (route === 'toolbar' || route === 'region' || route === 'border' || route === 'camera') {
  void import('./recorder/overlays/mountOverlay').then(m => m.mountOverlay(route))
} else if (route === 'shot-area' || route === 'shot-editor' || route === 'shot-thumb' || route === 'shot-pin' || route === 'shot-windows') {
  void import('./screenshot/windows/mountShot').then(m => m.mountShot(route))
} else if (route === 'rd-viewer' || route === 'rd-host' || route === 'rd-hostbar' || route === 'rd-request') {
  void import('./remote/windows/mountRemote').then(m => m.mountRemote(route))
} else {
  void import('./AppRoot')
}

export {}
