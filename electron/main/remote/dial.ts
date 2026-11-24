import { connect, type Socket } from 'node:net'
import type { RelayConn } from '../../../tools/remote-relay/relay'
import { dialThroughRelay } from './core/relayClient'

/** How to reach a host: straight over the LAN, or through the self-hosted relay. */
export type Route = { kind: 'direct'; host: string; port: number } | { kind: 'relay'; relay: string; deviceId: string }

export const routeLabel = (route: Route): string => (route.kind === 'direct' ? `${route.host}:${route.port}` : `relay ${route.relay}`)

const dialDirect = (host: string, port: number, timeoutMs: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`No answer from ${host}:${port}.`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      // Input and signalling are tiny and latency-bound: no Nagle delay.
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 5000)
      resolve(socket)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      const code = (error as NodeJS.ErrnoException).code
      reject(
        new Error(
          code === 'ECONNREFUSED'
            ? `${host} is not accepting remote connections (app closed, remote access off, or a firewall).`
            : code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
              ? `${host} cannot be reached from this network.`
              : error.message
        )
      )
    })
  })

export const dial = (route: Route, timeoutMs = 4000): Promise<RelayConn> =>
  route.kind === 'direct' ? dialDirect(route.host, route.port, timeoutMs) : dialThroughRelay(route.relay, route.deviceId)
