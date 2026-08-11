import { join } from 'node:path'
import { CATALOG_FILTER_POLICY_REVISION } from '../shared/catalog-policy.ts'
import type { CatalogFailureCode, CatalogLoadFailure } from '../shared/catalog-contracts.ts'
import { CatalogCacheRepository } from './catalog-cache.ts'
import { CatalogCoordinator, CatalogSyncError } from './catalog-coordinator.ts'
import { IptvOrgFetchError } from './catalog-upstream.ts'
import type { RuntimeConfig } from './runtime-config.ts'

export function createCatalogService(userDataPath: string, appVersion: string, runtime: RuntimeConfig): CatalogCoordinator {
  return new CatalogCoordinator({
    cache: new CatalogCacheRepository({
      v2Path: join(userDataPath, 'catalog-v2.json'),
      legacyV1Path: join(userDataPath, 'catalog-v1.json'),
      filterPolicyRevision: CATALOG_FILTER_POLICY_REVISION,
      appVersion
    }),
    runtime: {
      acceptanceUrl: runtime.smoke.acceptanceUrl,
      useAcceptanceCatalog: runtime.smoke.autoplay && Boolean(runtime.smoke.acceptanceUrl),
      useOfflineDemo: runtime.smoke.offlineDemo,
      forceNetworkFailure: runtime.smoke.forceNetworkFailure
    }
  })
}

export function toCatalogLoadFailure(error: unknown): CatalogLoadFailure {
  const normalized = normalizeCatalogError(error)
  const copy: Record<CatalogFailureCode, { title: string; message: string }> = {
    proxy: { title: '代理连接失败', message: '无法通过当前代理连接 iptv-org，请检查 macOS、PAC、VPN 或本机代理状态。' },
    dns: { title: '域名解析失败', message: '无法解析 iptv-org 的公网地址，请检查 DNS 或网络连接。' },
    timeout: { title: '连接 iptv-org 超时', message: '频道目录请求超过时间上限，可以稍后重新尝试。' },
    http: { title: 'iptv-org 暂时不可用', message: '上游服务返回临时错误，可以稍后重新尝试。' },
    security: { title: '安全检查未通过', message: '远程响应没有通过公网地址、TLS、重定向或大小限制检查。' },
    'safety-data': { title: '安全过滤数据获取失败', message: 'blocklist 是当前安全策略的必需输入，未获取成功前不会展示真实频道。' },
    'invalid-data': { title: '频道目录格式异常', message: 'iptv-org 响应无法生成符合当前安全规则的频道目录。' },
    'cache-write': { title: '本机缓存验证失败', message: '频道目录已获取，但未能安全写入并重新读取本机缓存。' },
    network: { title: '无法连接 iptv-org', message: '当前网络无法完成频道目录同步，请检查连接后重新尝试。' },
    unknown: { title: '频道目录加载失败', message: '发生了未识别的目录错误，请重新尝试。' }
  }
  return {
    code: normalized.code,
    title: copy[normalized.code].title,
    message: copy[normalized.code].message,
    detail: sanitizeFailureDetail(normalized.detail),
    retryable: normalized.retryable
  }
}

function normalizeCatalogError(error: unknown): { code: CatalogFailureCode; retryable: boolean; detail: string } {
  if (error instanceof CatalogSyncError || error instanceof IptvOrgFetchError) {
    return { code: error.code, retryable: error.retryable, detail: error.message }
  }
  return {
    code: 'unknown',
    retryable: false,
    detail: error instanceof Error ? error.message : String(error)
  }
}

function sanitizeFailureDetail(value: string): string {
  return value
    .replace(/https:\/\/[^\s)]+/gi, '[远程地址]')
    .replace(/(token|signature|key|password)=[^&\s]+/gi, '$1=[已隐藏]')
    .slice(0, 1_000)
}
