const assert = require('node:assert/strict')
const test = require('node:test')

const {
  DEFAULT_TTN_ARCADE_URL,
  DEFAULT_TTN_CHAINTRACKS_API_PREFIX,
  arcadeUrlForNetwork,
  chaintracksApiPrefixForNetwork,
  chaintracksUrlForNetwork,
  normalizeProjectNetwork,
  projectNetworkToOverlayNetwork,
  projectNetworkToWalletChain,
  propagationEnvironmentForNetwork,
  storageUrlForChain,
} = require('../dist/src/network.js')

test('normalizes supported public and runtime network names', () => {
  assert.equal(normalizeProjectNetwork(undefined), 'mainnet')
  assert.equal(normalizeProjectNetwork('main'), 'mainnet')
  assert.equal(normalizeProjectNetwork('test'), 'testnet')
  assert.equal(normalizeProjectNetwork('ttn'), 'teratestnet')
  assert.equal(normalizeProjectNetwork('teratestnet'), 'teratestnet')
  assert.throws(() => normalizeProjectNetwork('regtest'), /Unsupported project network/)
})

test('maps TerraTestNet to the distinct wallet and overlay chain', () => {
  assert.equal(projectNetworkToWalletChain('teratestnet'), 'ttn')
  assert.equal(projectNetworkToOverlayNetwork('teratestnet'), 'ttn')
  assert.equal(projectNetworkToWalletChain('testnet'), 'test')
})

test('uses isolated TTN storage, Arcade, and ChainTracks defaults', () => {
  const env = {}
  assert.equal(storageUrlForChain('ttn', env), 'https://staging-storage.babbage.systems')
  assert.equal(arcadeUrlForNetwork('teratestnet', env), DEFAULT_TTN_ARCADE_URL)
  assert.equal(chaintracksUrlForNetwork('teratestnet', env), DEFAULT_TTN_ARCADE_URL)
  assert.equal(chaintracksApiPrefixForNetwork('teratestnet', env), DEFAULT_TTN_CHAINTRACKS_API_PREFIX)
  assert.equal(arcadeUrlForNetwork('testnet', env), undefined)
})

test('honors operator TTN endpoint overrides without affecting testnet', () => {
  const env = {
    TTN_STORAGE_URL: 'https://storage.ttn.example',
    TTN_ARCADE_URL: 'https://arcade.ttn.example',
    TTN_CHAINTRACKS_URL: 'https://chaintracks.ttn.example',
    TTN_CHAINTRACKS_API_PREFIX: '/chaintracks/custom',
  }
  assert.equal(storageUrlForChain('ttn', env), env.TTN_STORAGE_URL)
  assert.equal(arcadeUrlForNetwork('teratestnet', env), env.TTN_ARCADE_URL)
  assert.equal(chaintracksUrlForNetwork('teratestnet', env), env.TTN_CHAINTRACKS_URL)
  assert.equal(chaintracksApiPrefixForNetwork('teratestnet', env), env.TTN_CHAINTRACKS_API_PREFIX)
  assert.equal(storageUrlForChain('test', env), 'https://staging-storage.babbage.systems')
})

test('generated deployment wiring derives the overlay and propagation environment from the project network', () => {
  const compiled = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'dist', 'src', 'routes', 'upload.js'),
    'utf8'
  )
  assert.match(compiled, /projectNetworkToOverlayNetwork/)
  assert.match(compiled, /propagationEnvironmentForNetwork/)
})

test('TTN propagation environment cannot inherit legacy ARC', () => {
  const env = {
    TAAL_API_KEY_TEST: 'must-not-leak',
    TTN_ARCADE_URL: 'https://arcade.ttn.example',
  }
  const ttn = propagationEnvironmentForNetwork('teratestnet', 'project-123', env)
  assert.equal(ttn.ARCADE_URL, env.TTN_ARCADE_URL)
  assert.equal(ttn.CHAINTRACKS_URL, env.TTN_ARCADE_URL)
  assert.equal(ttn.ARCADE_DEPLOYMENT_ID, 'project-123')
  assert.equal(Object.hasOwn(ttn, 'ARC_API_KEY'), false)

  const testnet = propagationEnvironmentForNetwork('testnet', 'project-123', env)
  assert.deepEqual(testnet, { ARC_API_KEY: env.TAAL_API_KEY_TEST })
  assert.equal(Object.hasOwn(testnet, 'ARCADE_URL'), false)
})

test('released wallet services install Arcade as the sole TTN broadcaster', () => {
  const { Services } = require('@bsv/wallet-toolbox-client')
  const services = new Services('ttn')
  assert.equal(services.options.arcUrl, '')
  assert.equal(services.options.arcadeUrl, DEFAULT_TTN_ARCADE_URL)
  assert.deepEqual(
    services.postBeefServices.services.map(provider => provider.name),
    ['ArcadeBeef']
  )
  assert.equal(
    services.options.chaintracks.baseUrl,
    `${DEFAULT_TTN_ARCADE_URL}${DEFAULT_TTN_CHAINTRACKS_API_PREFIX}`
  )
})
