import { sign } from 'node:crypto'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { RELAY_REGISTER_LABEL, readLine, startRelay, TUNNEL_LIMITS, tunnelPortsFromEnv, writeLine } from '../tools/remote-relay/relay'
import { failedLoopbackPorts, newTunnelIdentity, TunnelHost } from '../electron/main/vps/tunnelCore'

/*
 * VPS Manager's SSH tunnel over real TCP: a relay, a stand-in SSH server
 * (sends a banner, then echoes) and visitors on the tunnel's public port.
 */

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(fn => fn()))

const listen = (server: Server): Promise<number> => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

/** A fake sshd: banner first, then echo. Records each client's source port. */
const fakeSshd = async () => {
  const sourcePorts: number[] = []
  const server = createServer(socket => {
    sourcePorts.push(socket.remotePort ?? 0)
    socket.write('SSH-2.0-FakeSSH\r\n')
    socket.pipe(socket)
  })
  const port = await listen(server)
  cleanups.push(() => server.close())
  return { port, sourcePorts }
}

const relay = async () => {
  const server = await startRelay({ port: 0, host: '127.0.0.1', log: () => undefined, tunnels: { first: 0, last: 0 } })
  cleanups.push(() => server.close())
  return `127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** Start a tunnel and wait until the relay gave it a public port. */
const tunnel = async (relayAddress: string, target: number, events: { sessions?: [string, number][] } = {}) => {
  const { identity } = newTunnelIdentity()
  let resolveOnline: (port: number) => void = () => undefined
  const online = new Promise<number>(resolve => (resolveOnline = resolve))
  const states: string[] = []
  const host = new TunnelHost({
    relay: relayAddress,
    identity: () => identity,
    target: () => target,
    events: {
      onState: (state, info) => {
        states.push(state)
        if (state === 'online' && info.port) resolveOnline(info.port)
      },
      onSession: (from, localPort) => events.sessions?.push([from, localPort])
    }
  })
  host.start()
  cleanups.push(() => host.stop())
  return { host, port: await online, identity, states }
}

/** Connect as a visitor; resolves with the first data received, or null when the relay drops the connection. */
const visit = (port: number, send?: string): Promise<{ data: string | null; socket: Socket }> =>
  new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    let data = ''
    socket.on('data', chunk => {
      data += chunk.toString()
      if (!send || data.includes(send)) resolve({ data, socket })
    })
    socket.once('connect', () => send && socket.write(send))
    socket.once('close', () => resolve({ data: data || null, socket }))
    socket.on('error', () => undefined)
    cleanups.push(() => socket.destroy())
  })

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('VPS SSH tunnel through the relay', () => {
  it('pipes a visitor to the local SSH server, byte for byte, and traces the session', async () => {
    const sshd = await fakeSshd()
    const sessions: [string, number][] = []
    const { port } = await tunnel(await relay(), sshd.port, { sessions })
    const { data, socket } = await visit(port, 'hello-through-the-relay')
    expect(data).toContain('SSH-2.0-FakeSSH')
    expect(data).toContain('hello-through-the-relay')
    // The visitor's address, and the local port sshd sees it on (what its log says "from 127.0.0.1 port …").
    await until(() => sessions.length === 1)
    expect(sessions[0]?.[0]).toBe('127.0.0.1')
    expect(sshd.sourcePorts).toContain(sessions[0]?.[1])
    socket.destroy()
  })

  it('refuses a banned visitor address', async () => {
    const sshd = await fakeSshd()
    const { host, port } = await tunnel(await relay(), sshd.port)
    expect((await visit(port)).data).toContain('SSH-2.0')
    host.ban('127.0.0.1', 5)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await visit(port)).data).toBeNull()
  })

  it('bans an address that opens too many connections', async () => {
    const sshd = await fakeSshd()
    const { port } = await tunnel(await relay(), sshd.port)
    const results = []
    for (let i = 0; i < TUNNEL_LIMITS.perMinute + 2; i++) {
      const r = await visit(port)
      results.push(r.data)
      r.socket.destroy()
    }
    expect(results.slice(0, TUNNEL_LIMITS.perMinute).every(d => d?.includes('SSH-2.0'))).toBe(true)
    expect(results.at(-1)).toBeNull()
  })

  it('closes the public port when the computer goes offline', async () => {
    const sshd = await fakeSshd()
    const { host, port } = await tunnel(await relay(), sshd.port)
    host.stop()
    await new Promise(resolve => setTimeout(resolve, 150))
    expect((await visit(port)).data).toBeNull()
  })

  it('refuses a forged registration, and a Remote Desktop registration replayed as a tunnel', async () => {
    const address = await relay()
    const [h, p] = address.split(':')
    const { identity } = newTunnelIdentity()
    for (const label of ['wrong label', RELAY_REGISTER_LABEL]) {
      const socket = connect({ host: h as string, port: Number(p) })
      cleanups.push(() => socket.destroy())
      const hello = await readLine(socket, 3000)
      const nonce = Buffer.from(String(hello['nonce']), 'base64')
      const sig = sign(null, Buffer.concat([Buffer.from(label), nonce]), identity.privateKey)
      writeLine(socket, { op: 'tunnel-register', id: identity.id, pub: identity.publicKey.toString('base64'), sig: sig.toString('base64') })
      expect((await readLine(socket, 3000))['op']).toBe('error')
    }
  })

  it('a relay without tunnels says so', async () => {
    const server = await startRelay({ port: 0, host: '127.0.0.1', log: () => undefined })
    cleanups.push(() => server.close())
    const errors: string[] = []
    const { identity } = newTunnelIdentity()
    const host = new TunnelHost({
      relay: `127.0.0.1:${(server.address() as AddressInfo).port}`,
      identity: () => identity,
      target: () => 1,
      events: { onState: (state, info) => state === 'error' && info.error && errors.push(info.error) }
    })
    host.start()
    cleanups.push(() => host.stop())
    await until(() => errors.length > 0)
    expect(errors[0]).toMatch(/does not offer SSH tunnels/)
  })
})

describe('tunnel helpers', () => {
  it('finds failed logins that came through the tunnel', () => {
    const log = [
      'Failed password for vpsuser from 127.0.0.1 port 50001 ssh2',
      'Invalid user bob from 127.0.0.1 port 50002',
      'Failed password for invalid user bob from 127.0.0.1 port 50002 ssh2',
      'Failed password for my user from ::1 port 50003 ssh2',
      'Failed password for vpsuser from 192.168.1.9 port 50004 ssh2',
      'Accepted password for vpsuser from 127.0.0.1 port 50005 ssh2'
    ].join('\n')
    expect(failedLoopbackPorts(log)).toEqual([50001, 50002, 50003])
  })

  it('reads SSH_TUNNEL_PORTS', () => {
    expect(tunnelPortsFromEnv({})).toEqual({ first: 22000, last: 22999 })
    expect(tunnelPortsFromEnv({ SSH_TUNNEL_PORTS: '30000-30010' })).toEqual({ first: 30000, last: 30010 })
    expect(tunnelPortsFromEnv({ SSH_TUNNEL_PORTS: 'off' })).toBeNull()
    expect(tunnelPortsFromEnv({ SSH_TUNNEL_PORTS: '80-90' })).toBeNull()
  })
})
