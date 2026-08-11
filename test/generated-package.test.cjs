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
