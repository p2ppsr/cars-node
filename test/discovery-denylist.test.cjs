const assert = require('node:assert/strict')
const test = require('node:test')

const {
  DEFAULT_DISCOVERY_DENYLIST,
  discoveryDenylist,
  installDiscoveryDenylist,
  normalizeDiscoveryDomain
} = require('../dist/src/discovery-denylist.js')
const { SHIPStorage } = require('@bsv/overlay-discovery-services')

test('discovery denylist normalizes configured domains', () => {
  assert.equal(normalizeDiscoveryDomain(' HTTPS://EXAMPLE.COM/// '), 'https://example.com')
  assert.deepEqual([...discoveryDenylist(' HTTPS://EXAMPLE.COM///,https://other.example/ ')], [
    'https://example.com',
    'https://other.example'
  ])
})

test('default discovery denylist contains retired and repeatedly unavailable providers', () => {
  assert.ok(DEFAULT_DISCOVERY_DENYLIST.includes(
    'https://backend.463a5e81e29fe79f94d3381b7a42d6be.projects.metanet.club'
  ))
  assert.ok(DEFAULT_DISCOVERY_DENYLIST.includes(
    'https://backend.3ba03bd20ec0fae6602b1574c1446678.apps.beta.calhouncars.com'
  ))
  assert.ok(DEFAULT_DISCOVERY_DENYLIST.includes(
    'https://backend.841c25be1e7c197d1a502676725ea2d2.cars.metanet.club'
  ))
  assert.ok(DEFAULT_DISCOVERY_DENYLIST.includes(
    'https://backend.2f1a64dd7f952437e06a5053ccc5a9e4.projects.babbage.systems'
  ))
  assert.equal(DEFAULT_DISCOVERY_DENYLIST.length, new Set(DEFAULT_DISCOVERY_DENYLIST).size)
})

test('discovery storage rejects denied domains and prefers the controller identity', async () => {
  const preferredIdentityKey = '02'.padEnd(66, '1')
  installDiscoveryDenylist('https://blocked.example', preferredIdentityKey)

  const calls = []
  const storage = Object.create(SHIPStorage.prototype)
  storage.ensureIndexes = async () => {}
  storage.shipRecords = {
    deleteMany: async filter => { calls.push(['deleteMany', filter]) },
    findOne: async () => null,
    updateOne: async (filter, update, options) => { calls.push(['updateOne', filter, update, options]) }
  }

  await storage.storeSHIPRecord('blocked', 0, preferredIdentityKey, 'https://blocked.example/', 'tm_example')
  assert.deepEqual(calls, [])

  await storage.storeSHIPRecord('preferred', 1, preferredIdentityKey, 'https://live.example', 'tm_example')
  assert.equal(calls[0][0], 'deleteMany')
  assert.equal(calls[1][0], 'updateOne')
})
