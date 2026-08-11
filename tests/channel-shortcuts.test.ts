import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendChannelNumberDigit,
  channelIndexForNumber,
  hasLongerChannelNumber
} from '../src/shared/channel-shortcuts.ts'

test('数字选台使用一基编号并拒绝零开头和越界频道', () => {
  assert.equal(appendChannelNumberDigit('', '0', 123), '')
  assert.equal(appendChannelNumberDigit('', '1', 123), '1')
  assert.equal(appendChannelNumberDigit('1', '2', 123), '12')
  assert.equal(channelIndexForNumber('1', 123), 0)
  assert.equal(channelIndexForNumber('123', 123), 122)
  assert.equal(channelIndexForNumber('124', 123), undefined)
})

test('数字选台只在仍可能形成有效长编号时等待后续数字', () => {
  assert.equal(hasLongerChannelNumber('1', 12), true)
  assert.equal(hasLongerChannelNumber('2', 12), false)
  assert.equal(hasLongerChannelNumber('80', 8_000), true)
  assert.equal(hasLongerChannelNumber('8000', 8_000), false)
})
