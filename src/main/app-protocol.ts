import { protocol, session } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_PROTOCOL } from '../shared/ipc-contract.ts'
import type { RuntimeConfig } from './runtime-config.ts'
import type { RemoteResourceBroker } from './remote-resource-broker.ts'

export const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob: tvfeed:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export function registerPrivilegedScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: APP_PROTOCOL.scheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }])
}

export async function registerAppProtocol(runtime: RuntimeConfig, resources: RemoteResourceBroker): Promise<void> {
  const rendererRoot = resolve(fileURLToPath(new URL('../renderer/', import.meta.url)))
  protocol.handle(APP_PROTOCOL.scheme, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== APP_PROTOCOL.host) return new Response('Not found', { status: 404 })
      if (url.pathname.startsWith(APP_PROTOCOL.remoteStreamPathPrefix)) {
        return resources.handleStreamRequest(request, url)
      }
      if (runtime.rendererUrl) return new Response('Not found', { status: 404 })
      const requestPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      const absolutePath = resolve(rendererRoot, `.${requestPath}`)
      if (absolutePath !== rendererRoot && !absolutePath.startsWith(`${rendererRoot}${sep}`)) {
        return new Response('Forbidden', { status: 403 })
      }
      const body = await readFile(absolutePath)
      const headers: Record<string, string> = {
        'Content-Type': mimeTypeFor(absolutePath),
        'Cache-Control': absolutePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable'
      }
      if (absolutePath.endsWith('index.html')) headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY
      return new Response(body, { headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

export function hardenSession(runtime: RuntimeConfig): void {
  const currentSession = session.defaultSession
  currentSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  currentSession.setPermissionCheckHandler(() => false)
  currentSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => callback(isAllowedDevelopmentRequest(details.url, runtime) ? {} : { cancel: true })
  )
}

export function isTrustedRendererUrl(url: string, runtime: RuntimeConfig): boolean {
  if (runtime.rendererUrl) {
    try {
      return new URL(url).origin === new URL(runtime.rendererUrl).origin
    } catch {
      return false
    }
  }
  return url.startsWith(`${APP_PROTOCOL.scheme}://${APP_PROTOCOL.host}/`)
}

export function assertTrustedSender(url: string, runtime: RuntimeConfig): void {
  if (!isTrustedRendererUrl(url, runtime)) throw new Error('拒绝来自未知页面的请求')
}

function isAllowedDevelopmentRequest(url: string, runtime: RuntimeConfig): boolean {
  if (!runtime.rendererUrl) return false
  try {
    return new URL(url).origin === new URL(runtime.rendererUrl).origin
  } catch {
    return false
  }
}

function mimeTypeFor(path: string): string {
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.woff2': 'font/woff2'
  }[extname(path).toLocaleLowerCase()] ?? 'application/octet-stream'
}
