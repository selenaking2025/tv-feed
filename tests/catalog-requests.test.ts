import assert from 'node:assert/strict'
import test from 'node:test'
import { CatalogRequests } from '../src/renderer/src/catalog-requests.ts'

test('刷新使旧启动结果和进度失效，重载窗口后的旧进度也不能接管新界面', () => {
  const requests = new CatalogRequests()
  const startup = requests.begin()
  const startupCommand = requests.command('startup', startup)
  const refresh = requests.begin()
  const refreshCommand = requests.command('refresh', refresh)
  assert.equal(requests.isCurrent(startup), false)
  assert.equal(requests.isCurrent(refresh), true)
  assert.equal(requests.acceptsProgress({operationId:'old', stage:'processing', message:'old', ...startupCommand}), false)
  assert.equal(requests.acceptsProgress({operationId:'new', stage:'processing', message:'new', ...refreshCommand}), true)
  const replacement = new CatalogRequests()
  replacement.begin()
  assert.equal(replacement.acceptsProgress({operationId:'old',stage:'checking-cache',message:'old',...startupCommand}), false)
})
