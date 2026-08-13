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

test('legacy index shim disables local discovery services and advertisement writes', () => {
  const {
    generateCentralizedAdvertisementsIndexTs,
    generateSafeAccessLoggerCjs
  } = require('../dist/src/utils.js')
  const legacyIndex = `import OverlayExpress from '@bsv/overlay-express'\nconst main = async () => {\n  await server.configureEngine();\n  await server.start();\n}`
  const thinIndex = generateCentralizedAdvertisementsIndexTs(legacyIndex)
  const requestLogger = generateSafeAccessLoggerCjs()

  assert.match(thinIndex, /server\.configureEngine\(false\)/)
  assert.match(thinIndex, /server\.engine\.syncAdvertisements = async/)
  assert.match(thinIndex, /advertiser: carsNodePassiveAdvertiser/)
  assert.match(thinIndex, /CARSNodePushDrop/)
  assert.match(requestLogger, /CARS_CENTRALIZED_ADVERTISEMENTS/)
  assert.match(requestLogger, /randomBytes\(32\)/)
  assert.doesNotMatch(requestLogger, /overlay-express/)
  assert.equal(generateCentralizedAdvertisementsIndexTs(thinIndex), thinIndex)
})
