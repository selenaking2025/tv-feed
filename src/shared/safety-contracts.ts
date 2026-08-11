export interface LegacySafetyPreferences {
  familySafety: boolean
  remoteLogos: boolean
}

export interface SafetyStateSnapshot {
  schemaVersion: 1
  revision: number
  familySafety: boolean
  remoteLogos: boolean
  transitionId: string
  pendingCatalogInvalidation: boolean
  pendingViewingDataClear: boolean
}

export interface SafetyTransitionResult {
  state: SafetyStateSnapshot
  warning: string
}
