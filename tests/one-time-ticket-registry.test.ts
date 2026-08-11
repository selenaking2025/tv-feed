import assert from 'node:assert/strict'
import test from 'node:test'
import { OneTimeTicketRegistry } from '../src/main/one-time-ticket-registry.ts'

test('安全媒体流票据只能消费一次并在期限后失效', () => {
  let sequence = 0
  const registry = new OneTimeTicketRegistry<string>(100, 2, () => `ticket_${String(++sequence).padStart(32, '0')}`)
  const issued = registry.issue('first', 1_000)

  assert.equal(registry.consume(issued.token, 1_050), 'first')
  assert.equal(registry.consume(issued.token, 1_051), undefined)

  const expired = registry.issue('expired', 2_000)
  assert.equal(registry.consume(expired.token, 2_100), undefined)
  assert.equal(registry.size, 1)
  assert.deepEqual(registry.sweep(2_100), ['expired'])
  assert.equal(registry.consume(expired.token, 2_100), undefined)
})

test('安全媒体流票据有全局容量并支持按所有者撤销', () => {
  let sequence = 0
  const registry = new OneTimeTicketRegistry<{ senderId: number }>(100, 2, () => `ticket_${String(++sequence).padStart(32, '0')}`)
  registry.issue({ senderId: 1 }, 0)
  registry.issue({ senderId: 2 }, 0)
  assert.throws(() => registry.issue({ senderId: 3 }, 0), /容量上限/)
  assert.deepEqual(registry.removeWhere((entry) => entry.senderId === 1), [{ senderId: 1 }])
  assert.equal(registry.size, 1)
  assert.equal(registry.clear().length, 1)
  assert.equal(registry.size, 0)
})
