import type { Api, Events } from '../shared/types'

declare global {
  interface Window {
    sidekick: {
      invoke<K extends keyof Api>(
        channel: K,
        ...args: Parameters<Api[K]>
      ): Promise<ReturnType<Api[K]>>
      on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void
    }
  }
}
