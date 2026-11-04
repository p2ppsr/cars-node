const assert = require('node:assert/strict')
const test = require('node:test')
const { Services, GoChaintracksServiceClient } = require('@bsv/wallet-toolbox-client')
const { walletServiceOptions } = require('../dist/src/utils/wallet-services.js')

test('mainnet uses the qualified v2 provider without changing wallet service defaults', async () => {
  const normal = Services.createDefaultOptions('main')
  const options = walletServiceOptions('main', { CARS_MAINNET_CHAINTRACKS_URL: 'https://headers.example.invalid/v2' })
  assert.ok(options.chaintracks instanceof GoChaintracksServiceClient)
  assert.equal(options.chaintracks.baseUrl, 'https://headers.example.invalid/v2')
  assert.equal(options.chaintracks.chain, 'main')
  // Toolbox generates a fresh broadcaster deployment ID on each factory call.
  const stable = value => JSON.parse(JSON.stringify(value, (key, data) => ['chaintracks', 'deploymentId'].includes(key) ? undefined : data))
  assert.deepEqual(stable(options), stable(normal))
  assert.equal(walletServiceOptions('main', {}).chaintracks.baseUrl, normal.chaintracks.baseUrl)
})

test('the configured provider still rejects missing headers and mismatched Merkle roots', async () => {
  const original = global.fetch, seen = [], root = 'ab'.repeat(32)
  global.fetch = async input => {
    const url = new URL(String(input)); seen.push(url.href)
    assert.equal(url.origin, 'https://headers.example.invalid')
    if (url.pathname === '/v2/network') return Response.json({ network: 'mainnet' })
    if (url.pathname === '/v2/header/height/123') return Response.json({ height: 123, merkleRoot: root })
    return new Response('', { status: 404 })
  }
  try {
    const client = walletServiceOptions('main', { CARS_MAINNET_CHAINTRACKS_URL: 'https://headers.example.invalid/v2' }).chaintracks
    assert.equal(await client.getChain(), 'main')
    assert.equal(await client.isValidRootForHeight(root, 123), true)
    assert.equal(await client.isValidRootForHeight('cd'.repeat(32), 123), false)
    assert.equal(await client.isValidRootForHeight(root, 124), false)
    assert.equal(seen.length, 4)
  } finally { global.fetch = original }
})

test('invalid mainnet configuration fails closed while other networks retain their configuration', () => {
  for (const endpoint of ['http://headers.example/v2', 'https://user:secret@headers.example/v2', 'https://headers.example/v2?q=1', 'https://headers.example/v2#fragment', 'https://headers.example/v1']) {
    assert.throws(() => walletServiceOptions('main', { CARS_MAINNET_CHAINTRACKS_URL: endpoint }))
  }
  const override = { CARS_MAINNET_CHAINTRACKS_URL: 'https://headers.example.invalid/v2' }
  assert.equal(walletServiceOptions('test', override).chaintracks.baseUrl, Services.createDefaultOptions('test').chaintracks.baseUrl)
  const ttn = walletServiceOptions('ttn', { ...override, TTN_ARCADE_URL: 'https://ttn.example.invalid', TTN_ARCADE_API_KEY: 'synthetic-test-only', TTN_ARCADE_DEPLOYMENT_ID: 'synthetic-deployment' })
  assert.equal(ttn.chaintracks.baseUrl, Services.createDefaultOptions('ttn').chaintracks.baseUrl)
  assert.equal(ttn.arcadeUrl, 'https://ttn.example.invalid')
  assert.equal(ttn.arcadeConfig.apiKey, 'synthetic-test-only')
  assert.equal(ttn.arcadeConfig.deploymentId, 'synthetic-deployment')
})
