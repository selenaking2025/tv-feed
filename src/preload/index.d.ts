import type { TvFeedBridge } from '../shared/ipc-contract.ts'

declare global {
  interface Window {
    tvFeed: TvFeedBridge
  }
}

export {}
