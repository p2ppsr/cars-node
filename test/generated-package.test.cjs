const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('generated overlays pin the TTN-compatible Overlay Express release', () => {
  const compiled = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'src', 'utils.js'),
    'utf8'
  )

  assert.match(compiled, /"@bsv\/overlay-express": "2\.6\.0"/)
  assert.doesNotMatch(compiled, /"@bsv\/overlay-express": "2\.5\.1"/)
})

test('generated overlays configure TTN Arcade and ChainTracks without ARC fallback', () => {
  const { generateIndexTs } = require('../dist/src/utils.js')
  const generated = generateIndexTs({ schema: 'bsv-app', schemaVersion: '1.0' })

  assert.match(generated, /server\.configureNetwork\(network\)/)
  assert.match(generated, /server\.configureArcade\(arcadeUrl/)
  assert.match(generated, /server\.configureChaintracks\(chaintracksUrl/)
  assert.match(generated, /network !== 'ttn' && process\.env\.ARC_API_KEY/)
  assert.match(generated, /https:\/\/arcade-v2-ttn-us-1\.bsvblockchain\.tech/)
})

test('generated project backends are thin advertisement consumers', () => {
  const { generateIndexTs, generatePackageJson } = require('../dist/src/utils.js')
  const generated = generateIndexTs({ schema: 'bsv-app', schemaVersion: '1.0' })
  const packageJson = generatePackageJson({})

  assert.match(generated, /crypto\.randomBytes\(32\)/)
  assert.match(generated, /advertiser: passiveAdvertiser/)
  assert.match(generated, /server\.configureEngine\(false\)/)
  assert.doesNotMatch(generated, /process\.env\.SERVER_PRIVATE_KEY/)
  assert.equal(packageJson.dependencies['@bsv/sdk'], '2.4.0')
})

test('legacy ESM preload disables local discovery services and advertisement writes', () => {
  const {
    generateCentralizedAdvertisementsPreloadMjs,
    generateSafeAccessLoggerCjs
  } = require('../dist/src/utils.js')
  const preload = generateCentralizedAdvertisementsPreloadMjs()
  const requestLogger = generateSafeAccessLoggerCjs()

  assert.match(preload, /CARS_CENTRALIZED_ADVERTISEMENTS/)
  assert.match(preload, /originalConfigureEngine\.call\(this, false\)/)
  assert.match(preload, /Engine\.prototype\.syncAdvertisements/)
  assert.match(preload, /crypto\.randomBytes\(32\)/)
  assert.match(preload, /import OverlayExpress from '@bsv\/overlay-express'/)
  assert.doesNotMatch(requestLogger, /CARS_CENTRALIZED_ADVERTISEMENTS/)
})
