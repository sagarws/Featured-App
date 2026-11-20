import type { HistoryEntry, IceServer, RemoteSettings } from '@shared/types/remote'
import type { HostSession } from './hostSession'
import type { InputInjector } from './input/injector'
import type { TransferLink, Transfers } from './transfers'
import type { ViewerSession } from './viewerSession'

/** What a session needs from the service, without importing it (no cycles). */
export interface RemoteContext {
  settings: () => RemoteSettings
  iceServers: () => IceServer[]
  notify: () => void
  history: (entry: Omit<HistoryEntry, 'at'>) => void
  injector: InputInjector
  transfers: Transfers
  transferLink: (session: HostSession | ViewerSession) => TransferLink
  hostSessionEnded: (session: HostSession) => void
  viewerSessionEnded: (session: ViewerSession) => void
}
