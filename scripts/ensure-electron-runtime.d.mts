export interface ElectronRuntimeState {
  ready: boolean
  reason: 'ready' | 'package-missing' | 'binary-missing-or-incomplete'
  cause?: unknown
  version?: string
  packageRoot?: string
  installScript?: string
  expectedRelativePath?: string
  installedVersion?: string
  configuredRelativePath?: string
  executablePresent?: boolean
}

export function inspectElectronRuntime(root?: string): Promise<ElectronRuntimeState>
export function ensureElectronRuntime(root?: string): Promise<ElectronRuntimeState>
export function electronExecutableRelativePath(platform: string): string
