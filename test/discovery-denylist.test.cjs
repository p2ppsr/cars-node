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

test('default discovery denylist contains the retired Metanet provider', () => {
  assert.ok(DEFAULT_DISCOVERY_DENYLIST.includes(
    'https://backend.463a5e81e29fe79f94d3381b7a42d6be.projects.metanet.club'
  ))
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
