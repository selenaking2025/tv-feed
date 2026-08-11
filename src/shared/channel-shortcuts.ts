export const CHANNEL_NUMBER_COMMIT_DELAY_MS = 800
export const MAX_CHANNEL_NUMBER_DIGITS = 4

export function appendChannelNumberDigit(current: string, digit: string, channelCount: number): string {
  if (!/^\d$/.test(digit) || !Number.isSafeInteger(channelCount) || channelCount < 1) return current
  if (!current && digit === '0') return ''

  const maximumDigits = Math.min(MAX_CHANNEL_NUMBER_DIGITS, String(channelCount).length)
  return `${current}${digit}`.slice(0, maximumDigits)
}

export function channelIndexForNumber(value: string, channelCount: number): number | undefined {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(channelCount) || channelCount < 1) return undefined
  const channelNumber = Number(value)
  return channelNumber <= channelCount ? channelNumber - 1 : undefined
}

export function hasLongerChannelNumber(value: string, channelCount: number): boolean {
  const index = channelIndexForNumber(value, channelCount)
  if (index === undefined) return false
  return Number(value) * 10 <= channelCount && value.length < MAX_CHANNEL_NUMBER_DIGITS
}
