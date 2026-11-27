import { networkInterfaces } from 'node:os'
import { createServer, Socket } from 'node:net'
import { net } from 'electron'
import type { VpsInterface, VpsNetwork } from '@shared/types/vps'
import { classifyAddress, isPublicV4, VPS_PORT_RANGE } from '@shared/utils/vps'
import { logger } from '../logger'

/*
 * What this machine looks like on the network. Local only, except the public
 * address, which is a request to an outside service (api.ipify.org) and so
 * is made only when the user presses "Check public IP".
 *
 * A public address says nothing about reachability: behind a home router
 * (NAT) or a carrier's CGNAT, nobody outside can connect in without port
 * forwarding — which the app never sets up, and which the server refuses
 * anyway (it only accepts private and VPN sources).
 */

const PREFERRED = /^(en\d|eth\d|wlan\d|wlp|enp|eno|Wi-?Fi|Ethernet)/i

let publicIp: { value: string | null; error: string | null; at: number } | null = null

export const listInterfaces = (): VpsInterface[] => {
  const out: VpsInterface[] = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const a of addresses ?? []) {
      const family = a.family === 'IPv6' ? 'IPv6' : 'IPv4'
      out.push({ name, address: a.address, family, kind: classifyAddress(name, a.address, family, a.internal) })
    }
  }
  return out
}

/** The LAN address to hand out: a private IPv4, preferring Wi-Fi / Ethernet over virtual adapters. */
const pickLan = (list: VpsInterface[]): VpsInterface | null => {
  const lan = list.filter(i => i.kind === 'lan' && i.family === 'IPv4')
  return lan.find(i => PREFERRED.test(i.name)) ?? lan.find(i => !/vEthernet|docker|br-|virbr|vmnet|vboxnet/i.test(i.name)) ?? lan[0] ?? null
}

export const checkPublicIp = async (): Promise<void> => {
  try {
    const response = await net.fetch('https://api.ipify.org?format=text', { signal: AbortSignal.timeout(6000) })
    const text = (await response.text()).trim()
    publicIp = isPublicV4(text) ? { value: text, error: null, at: Date.now() } : { value: null, error: 'No public IPv4 address was reported.', at: Date.now() }
  } catch (error) {
    logger.warn('[vps] public IP check failed', error instanceof Error ? error.message : String(error))
    publicIp = { value: null, error: 'Could not reach the IP lookup service.', at: Date.now() }
  }
}

export const getNetwork = (): VpsNetwork => {
  const list = listInterfaces()
  const lan = pickLan(list)
  const vpn = list.find(i => i.kind === 'vpn' && i.family === 'IPv4') ?? list.find(i => i.kind === 'vpn') ?? null
  const ipv6 = list.find(i => i.family === 'IPv6' && i.kind === 'other') ?? null
  const fresh = publicIp && Date.now() - publicIp.at < 10 * 60_000 ? publicIp : null
  const local = new Set(list.map(i => i.address))
  return {
    online: net.isOnline(),
    interfaces: list.filter(i => i.kind !== 'loopback'),
    lanIp: lan?.address ?? null,
    lanInterface: lan?.name ?? null,
    vpnIp: vpn?.address ?? null,
    vpnInterface: vpn?.name ?? null,
    ipv6: ipv6?.address ?? null,
    publicIp: fresh?.value ?? null,
    publicIpError: fresh?.error ?? null,
    nat: fresh?.value ? (local.has(fresh.value) ? 'direct' : 'behind-nat') : 'unknown'
  }
}

/** Is the port free to listen on (all interfaces)? */
const portFree = (port: number): Promise<boolean> =>
  new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => server.close(() => resolve(true)))
  })

/** The first free port from 2222 up, or null. */
export const pickPort = async (): Promise<number | null> => {
  for (let port: number = VPS_PORT_RANGE.first; port <= VPS_PORT_RANGE.last; port++) {
    if (await portFree(port)) return port
  }
  return null
}

/** Does an SSH server answer on this port (its "SSH-2.0-…" banner)? */
export const sshAnswers = (port: number, timeoutMs = 1500): Promise<boolean> =>
  new Promise(resolve => {
    const socket = new Socket()
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('data', (data: Buffer) => finish(data.toString('latin1').startsWith('SSH-')))
    socket.connect(port, '127.0.0.1')
  })
