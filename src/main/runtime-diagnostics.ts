import type { BrowserWindow } from 'electron'
import type { RemoteResourceBroker } from './remote-resource-broker.ts'

const MAX_DIAGNOSTIC_LENGTH = 600

export function attachRuntimeDiagnostics(
  window: BrowserWindow,
  rendererId: number,
  resources: RemoteResourceBroker
): void {
  window.webContents.on('did-finish-load', () => {
    process.stderr.write(`TVFEED_DIAGNOSTIC load-finished target=${diagnosticTargetKind(window.webContents.getURL())}\n`)
  })
  window.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    process.stderr.write(
      `TVFEED_DIAGNOSTIC load-failed code=${code} target=${diagnosticTargetKind(validatedUrl)} detail=${sanitizeRuntimeDiagnostic(description)}\n`
    )
  })
  window.webContents.on('preload-error', (_event, _path, error) => {
    process.stderr.write(`TVFEED_DIAGNOSTIC preload-error detail=${sanitizeRuntimeDiagnostic(error.message)}\n`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    resources.abortSender(rendererId)
    process.stderr.write(
      `TVFEED_DIAGNOSTIC renderer-gone reason=${sanitizeRuntimeDiagnostic(details.reason)} exit=${details.exitCode}\n`
    )
  })
  window.on('unresponsive', () => {
    process.stderr.write('TVFEED_DIAGNOSTIC renderer-unresponsive\n')
  })
  window.on('responsive', () => {
    process.stderr.write('TVFEED_DIAGNOSTIC renderer-responsive\n')
  })
  window.webContents.on('console-message', (details) => {
    if (details.level !== 'warning' && details.level !== 'error') return
    process.stderr.write(
      `TVFEED_DIAGNOSTIC console level=${details.level} source=${diagnosticTargetKind(details.sourceId)} line=${details.lineNumber} message=${sanitizeRuntimeDiagnostic(details.message)}\n`
    )
  })
}

export function reportRuntimeLoadError(error: unknown, enabled: boolean): void {
  if (!enabled) return
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`TVFEED_DIAGNOSTIC load-rejected detail=${sanitizeRuntimeDiagnostic(message)}\n`)
}

export function sanitizeRuntimeDiagnostic(value: string): string {
  return value
    .replace(/\b(?:https?|file|tvfeed):\/\/[^\s)\]}>'"]+/gi, '[address]')
    .replace(/\/Users\/[^\s:]+/g, '[local path]')
    .replace(/\b[A-Za-z]:\\[^\s:]+/g, '[local path]')
    .replace(/\b(token|signature|key|password)=([^&\s]+)/gi, '$1=[hidden]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [hidden]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH)
}

export function diagnosticTargetKind(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === 'tvfeed:') return 'app'
    if (url.protocol === 'file:') return 'file'
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
        ? 'development'
        : 'remote'
    }
    return 'other'
  } catch {
    return value ? 'unknown' : 'none'
  }
}
