import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_METHODS, IPC_EVENT_CHANNEL, ipcChannel } from '../shared/api'

interface EventMessage {
  event: string
  payload: unknown
}

const api: Record<string, unknown> = {}

for (const method of API_METHODS) {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(ipcChannel(method), ...args)
}

api.on = (event: string, listener: (payload: unknown) => void): (() => void) => {
  const handler = (_e: IpcRendererEvent, message: EventMessage): void => {
    if (message && message.event === event) listener(message.payload)
  }
  ipcRenderer.on(IPC_EVENT_CHANNEL, handler)
  return () => {
    ipcRenderer.removeListener(IPC_EVENT_CHANNEL, handler)
  }
}

contextBridge.exposeInMainWorld('playout', api)
