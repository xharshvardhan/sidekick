// Exposes the typed `window.sidekick` bridge. Nothing else from Node or Electron reaches the page.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, Events } from '../shared/types'

const sidekick = {
  invoke<K extends keyof Api>(
    channel: K,
    ...args: Parameters<Api[K]>
  ): Promise<ReturnType<Api[K]>> {
    return ipcRenderer.invoke(channel, ...args)
  },
  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    const handler = (_e: IpcRendererEvent, payload: Events[K]): void => fn(payload)
    ipcRenderer.on(event, handler)
    return () => {
      ipcRenderer.removeListener(event, handler)
    }
  }
}

export type SidekickBridge = typeof sidekick

contextBridge.exposeInMainWorld('sidekick', sidekick)
