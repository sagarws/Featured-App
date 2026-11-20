#!/usr/bin/env node
/*
 * Remote Desktop end-to-end self-test and benchmark, on ONE computer: the app
 * connects to itself over 127.0.0.1 and is driven like a user would, through
 * the Chrome DevTools Protocol. Real code paths: TCP listener, handshake,
 * Argon2id, sessions, the capture window (getDisplayMedia), WebRTC, the viewer.
 *
 *   npm run remote:selftest      (builds, then runs this)
 *
 * Runs with a throwaway profile (--user-data-dir in the OS temp folder), so the
 * real device ID, password and history are not touched. Needs Screen Recording
 * permission for Electron on macOS. Keyboard/mouse injection is exercised up to
 * the main process; it only reaches the OS when Accessibility is granted, so
 * this test does not move your mouse unless you granted it.
 *
 * It cannot replace the two-machine checklist in docs/REMOTE_DESKTOP.md: both
 * ends share one CPU/GPU and there is no real network in between.
 */
const { spawn } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const port = 9333
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

const targets = async () => (await fetch(`http://127.0.0.1:${port}/json`)).json()
const waitTarget = async (pred, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const t = (await targets().catch(() => [])).find(pred)
    if (t) return t
    await sleep(250)
  }
  throw new Error('target not found')
}

const session = async target => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const evaluate = async (expression, timeout = 60000) => {
    const msgId = ++id
    const p = new Promise((res, rej) => { pending.set(msgId, res); setTimeout(() => rej(new Error('cdp timeout')), timeout) })
    ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    const m = await p
    if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 500))
    return m.result?.result?.value
  }
  return { evaluate, close: () => ws.close() }
}

const results = []
const run = async () => {

const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail) }

const main = await waitTarget(t => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('#'))
const host = await session(main)
await host.evaluate(`new Promise(r => { const t = setInterval(() => { if (window.printAgent?.remote) { clearInterval(t); r(true) } }, 100) })`)

// ── identity and listener ──
let status = await host.evaluate(`window.printAgent.remote.getStatus().then(r => r.value)`)
check('device ID generated', /^WD-\d{3}-\d{3}-\d{3}$/.test(status.identity.id), status.identity.id)
for (let i = 0; i < 20 && !status.server.listening; i++) { await sleep(250); status = await host.evaluate(`window.printAgent.remote.getStatus().then(r => r.value)`) }
check('listening for sessions', status.server.listening, `port ${status.server.port}`)
check('unattended off by default', status.settings.unattendedEnabled === false)
check('default session 30 min', status.settings.defaultMinutes === 30)
check('screen permission', status.permissions.screen === 'granted', status.permissions.screen)
log('input permission:', status.permissions.input, status.permissions.inputDetail ?? '')

// ── unattended: wrong then right password ──
const pw = 'Selftest-Pass-9!'
let r = await host.evaluate(`window.printAgent.remote.setPassword(${JSON.stringify(pw)})`)
check('set unattended password (Argon2id in Electron)', r.ok, r.error ?? '')
await host.evaluate(`window.printAgent.remote.updateSettings({ unattendedEnabled: true, defaultMinutes: 30 })`)
r = await host.evaluate(`window.printAgent.remote.connect({ target: '127.0.0.1', password: 'wrong-password-1' }, 'aa'.repeat(12))`)
check('wrong password refused', !r.ok && /Wrong password/.test(r.error), r.error)

const t0 = Date.now()
r = await host.evaluate(`window.printAgent.remote.connect({ target: '127.0.0.1', password: ${JSON.stringify(pw)} }, 'bb'.repeat(12))`)
check('unattended connect', r.ok, r.ok ? `session ${r.value.slice(0, 8)}… in ${Date.now() - t0} ms` : r.error)

// ── video arrives in the viewer ──
const viewerTarget = await waitTarget(t => t.url.includes('#rd-viewer'))
const viewer = await session(viewerTarget)
let video = null
const vStart = Date.now()
for (let i = 0; i < 80; i++) {
  video = await viewer.evaluate(`(() => { const v = document.querySelector('video'); return v ? { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, rs: v.readyState } : null })()`).catch(() => null)
  if (video && video.w > 0 && video.t > 0.5) break
  await sleep(250)
}
check('remote screen video plays', !!video && video.w > 0 && video.t > 0, JSON.stringify(video) + ` after ${Date.now() - vStart} ms`)

status = await host.evaluate(`window.printAgent.remote.getStatus().then(r => r.value)`)
const inc = status.sessions.find(s => s.direction === 'incoming')
const out = status.sessions.find(s => s.direction === 'outgoing')
check('host session active with control', inc?.state === 'active' && inc?.permission === 'control', JSON.stringify({ state: inc?.state, perm: inc?.permission, method: inc?.method }))
check('host enforces 30-min expiry', inc && inc.expiresAt && Math.abs(inc.expiresAt - inc.startedAt - 30 * 60000) < 2000)
check('viewer session active', out?.state === 'active')
check('authorized device recorded', status.authorized.length === 1)

// ── stats panel: open it, read fps / bitrate / input RTT ──
await viewer.evaluate(`(() => { const b = document.querySelector('button[aria-label="Connection statistics"]'); b?.click(); return !!b })()`)
await sleep(4000)
const statsText = await viewer.evaluate(`(() => { const el = [...document.querySelectorAll('div')].find(d => /fps ·/.test(d.textContent ?? '') && d.children.length >= 4); return el ? el.innerText : null })()`)
log('stats panel:\n' + statsText)
check('stats panel shows live numbers', !!statsText && /\d+ fps/.test(statsText))
const inputRtt = /input RTT ([\d.]+) ms/.exec(statsText ?? '')?.[1]
check('input data channel round trip', !!inputRtt, inputRtt ? `${inputRtt} ms` : 'no pong')

// ── input path: synthesize a click + key in the viewer; host main must accept it (injection itself is blocked by macOS without Accessibility) ──
const clicked = await viewer.evaluate(`(() => {
  const area = document.querySelector('video').parentElement; area.focus()
  const v = document.querySelector('video').getBoundingClientRect()
  const opts = { bubbles: true, clientX: v.left + v.width / 2, clientY: v.top + v.height / 2, pointerId: 1, button: 0 }
  area.dispatchEvent(new PointerEvent('pointermove', opts)); area.dispatchEvent(new PointerEvent('pointerdown', opts)); area.dispatchEvent(new PointerEvent('pointerup', opts))
  area.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'ShiftLeft', key: 'Shift' })); area.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, code: 'ShiftLeft', key: 'Shift' }))
  return true })()`)
check('viewer input dispatched', clicked === true)

// ── quality switch without reconnecting ──
await viewer.evaluate(`window.printAgent.remote.viewer.quality('ultra-low', 'readability')`)
await sleep(6000)
const lowStats = await viewer.evaluate(`(() => { const el = [...document.querySelectorAll('div')].find(d => /fps ·/.test(d.textContent ?? '') && d.children.length >= 4); return el ? el.innerText.split('\\n')[0] : null })()`)
const lowH = Number(/×(\d+)/.exec(lowStats ?? '')?.[1] ?? 0)
check('quality → Ultra Low (≤480p) live', lowH > 0 && lowH <= 482, lowStats ?? '')
await viewer.evaluate(`window.printAgent.remote.viewer.quality('high', 'readability')`)
await sleep(5000)
const highStats = await viewer.evaluate(`(() => { const el = [...document.querySelectorAll('div')].find(d => /fps ·/.test(d.textContent ?? '') && d.children.length >= 4); return el ? el.innerText.split('\\n')[0] : null })()`)
check('quality → High live', !!highStats && Number(/×(\d+)/.exec(highStats)?.[1] ?? 0) > lowH, highStats ?? '')

// ── multi-monitor: switch to the other display mid-session ──
const cfg = await viewer.evaluate(`window.printAgent.remote.viewer.config().then(r => r.value)`)
log('displays:', cfg.displays.map(d => `${d.id}=${d.width}x${d.height}${d.primary ? '*' : ''}`).join(' '))
if (cfg.displays.length > 1) {
  await viewer.evaluate(`window.printAgent.remote.viewer.quality('auto', 'readability')`)
  const other = cfg.displays.find(d => d.id !== cfg.displayId)
  await viewer.evaluate(`window.printAgent.remote.viewer.display(${JSON.stringify(other.id)})`)
  await sleep(4000)
  const shown = await viewer.evaluate(`(() => { const v = document.querySelector('video'); return v.videoWidth + 'x' + v.videoHeight })()`)
  check('switch monitor live', shown === `${other.width}x${other.height}`, `now showing ${shown}`)
  await viewer.evaluate(`window.printAgent.remote.viewer.display(${JSON.stringify(cfg.displayId)})`)
  await sleep(3000)
  const back = await viewer.evaluate(`(() => { const v = document.querySelector('video'); return v.videoWidth + 'x' + v.videoHeight })()`)
  check('switch back to the main monitor', back.startsWith(String(cfg.displays.find(d => d.id === cfg.displayId).width)), back)
}

// ── owner switches to view only, then ends the session ──
await host.evaluate(`window.printAgent.remote.setSessionPermission(${JSON.stringify(inc.sessionId)}, 'view')`)
await sleep(800)
const viewOnly = await viewer.evaluate(`document.body.innerText.includes('View only')`)
check('viewer told it is view only', viewOnly === true)
await host.evaluate(`window.printAgent.remote.endIncoming(${JSON.stringify(inc.sessionId)})`)
await sleep(1500)
const ended = await viewer.evaluate(`document.body.innerText.includes('Session ended')`).catch(() => false)
check('host disconnect ends the viewer', ended === true)
viewer.close()

// ── attended: request → reject, request → accept view-only for 5 min ──
for (const answer of ['reject', 'accept']) {
  await host.evaluate(`window.printAgent.remote.updateSettings({ unattendedEnabled: false })`)
  const pending = host.evaluate(`window.printAgent.remote.connect({ target: '127.0.0.1' }, '${answer === 'reject' ? 'cc' : 'dd'}'.repeat(12))`, 90000)
  const reqTarget = await waitTarget(t => t.url.includes('#rd-request'))
  const req = await session(reqTarget)
  await req.evaluate(`new Promise(r => setTimeout(r, 600))`)
  const info = await req.evaluate(`window.printAgent.remote.requestInfo(new URLSearchParams(location.hash.split('?')[1]).get('id')).then(r => r.value)`)
  check(`request window shows requester (${answer})`, !!info?.peerId && /^\d{3} \d{3}$/.test(info.verificationCode), `${info?.peerName} ${info?.peerId} code ${info?.verificationCode}`)
  await req.evaluate(`window.printAgent.remote.answerRequest(new URLSearchParams(location.hash.split('?')[1]).get('id'), { allow: ${answer === 'accept'}, permission: 'view', minutes: 5 })`, 3000).catch(() => null)
  const res = await pending
  if (answer === 'reject') check('rejected request refused', !res.ok && /declined/.test(res.error), res.error)
  else {
    check('accepted request connects', res.ok, res.error ?? '')
    await sleep(1500)
    const st = await host.evaluate(`window.printAgent.remote.getStatus().then(r => r.value)`)
    const s = st.sessions.find(x => x.direction === 'incoming' && x.state === 'active')
    check('accepted as view only, 5 minutes', s?.permission === 'view' && Math.abs(s.expiresAt - s.startedAt - 5 * 60000) < 2000, JSON.stringify({ perm: s?.permission }))
    await host.evaluate(`window.printAgent.remote.disconnect(${JSON.stringify(res.value)})`)
    await sleep(1500)
  }
}

const history = await host.evaluate(`window.printAgent.remote.history().then(r => r.value.map(e => e.direction + ':' + e.event))`)
log('history:', history.join(', '))
check('audit log records failures and sessions', history.includes('incoming:auth-failed') && history.includes('incoming:connected') && history.includes('incoming:rejected'))

const failed = results.filter(r => !r.ok)
log(`\n${results.length - failed.length}/${results.length} checks passed`)
host.close()
return failed.length
}

const profile = mkdtempSync(join(tmpdir(), 'featured-rd-selftest-'))
const electron = require('electron')
const app = spawn(electron, ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { cwd: join(__dirname, '..'), stdio: 'ignore' })
let code = 1
run()
  .then(failed => (code = failed ? 1 : 0))
  .catch(error => console.error(error))
  .finally(() => {
    app.kill()
    setTimeout(() => {
      rmSync(profile, { recursive: true, force: true })
      process.exit(code)
    }, 1500)
  })
