const { readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const plist = require('plist')

const unusedPrivacyKeys = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription'
]

module.exports = async function hardenPackagedMacApp(context) {
  if (context.electronPlatformName !== 'darwin') return

  const productFilename = context.packager.appInfo.productFilename
  const infoPath = join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Info.plist')
  const info = plist.parse(await readFile(infoPath, 'utf8'))

  info.NSAppTransportSecurity = {
    NSAllowsArbitraryLoads: false,
    NSAllowsLocalNetworking: false
  }

  for (const key of unusedPrivacyKeys) delete info[key]
  await writeFile(infoPath, plist.build(info), 'utf8')
}
