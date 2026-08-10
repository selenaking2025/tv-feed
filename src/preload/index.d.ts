import type { TvFeedBridge } from '../shared/contracts.ts'

declare global {
  interface Window {
    tvFeed: TvFeedBridge
  }
}

export {}
