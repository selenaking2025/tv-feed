import assert from 'node:assert/strict'
import test from 'node:test'
import { toCatalogLoadFailure } from '../src/main/catalog-service.ts'
import { IptvOrgFetchError } from '../src/main/catalog-upstream.ts'

test('目录同步为 fake-IP DNS 提供明确且脱敏的诊断', () => {
  const failure = toCatalogLoadFailure(new IptvOrgFetchError(
    'channels',
    'fake-ip-dns',
    '检测到 198.18.1.10，对应 https://private.example/channels.json?token=secret',
    false
  ))

  assert.equal(failure.code, 'fake-ip-dns')
  assert.equal(failure.retryable, false)
  assert.equal(failure.title, '检测到 fake-IP DNS')
  assert.match(failure.message, /198\.18\.0\.0\/15/)
  assert.match(failure.message, /显式开启兼容模式/)
  assert.doesNotMatch(JSON.stringify(failure), /private\.example|token=secret/i)
})
