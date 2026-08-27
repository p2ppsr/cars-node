const assert = require('node:assert/strict')
const test = require('node:test')

const {
  DEFAULT_DISCOVERY_CAPABILITY_DENYLIST,
  DEFAULT_DISCOVERY_DENYLIST,
  discoveryCapabilityDenylist,
  discoveryCapabilityKey,
  discoveryDenylist,
  installDiscoveryDenylist,
  normalizeDiscoveryDomain
} = require('../dist/src/discovery-denylist.js')
const { SHIPStorage, SLAPStorage } = require('@bsv/overlay-discovery-services')

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

test('capability denylist is exact and keeps the public root out of scope', () => {
  assert.equal(DEFAULT_DISCOVERY_CAPABILITY_DENYLIST.length, 36)
  const denied = discoveryCapabilityDenylist()
  const thinDomain = 'https://backend.161a4f0f091010a0f8a34a5d1d1b9dd7.projects.babbage.systems'
  assert.ok(denied.has(discoveryCapabilityKey('SHIP', `${thinDomain}/`, 'tm_ship')))
  assert.ok(denied.has(discoveryCapabilityKey('SLAP', thinDomain, 'ls_slap')))
  assert.ok(!denied.has(discoveryCapabilityKey('SHIP', thinDomain, 'tm_users')))
  assert.ok(!denied.has(discoveryCapabilityKey(
    'SHIP',
    'https://backend.c6a84fc53bb50c34e179dcd861eb3964.projects.babbage.systems',
    'tm_ship'
  )))
  assert.equal(denied.size, DEFAULT_DISCOVERY_CAPABILITY_DENYLIST.length)
})

test('discovery storage rejects denied domains and capabilities but preserves app claims', async () => {
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

  const thinDomain = 'https://backend.161a4f0f091010a0f8a34a5d1d1b9dd7.projects.babbage.systems'
  const shipCallCount = calls.length
  await storage.storeSHIPRecord('scoped-block', 2, preferredIdentityKey, thinDomain, 'tm_ship')
  assert.equal(calls.length, shipCallCount)
  await storage.storeSHIPRecord('app-allowed', 3, preferredIdentityKey, thinDomain, 'tm_users')
  assert.equal(calls.at(-1)[0], 'updateOne')

  const slapCalls = []
  const slapStorage = Object.create(SLAPStorage.prototype)
  slapStorage.ensureIndexes = async () => {}
  slapStorage.slapRecords = {
    deleteMany: async filter => { slapCalls.push(['deleteMany', filter]) },
    findOne: async () => null,
    updateOne: async (filter, update, options) => { slapCalls.push(['updateOne', filter, update, options]) }
  }
  await slapStorage.storeSLAPRecord('scoped-block', 4, preferredIdentityKey, thinDomain, 'ls_slap')
  assert.deepEqual(slapCalls, [])
  await slapStorage.storeSLAPRecord('app-allowed', 5, preferredIdentityKey, thinDomain, 'ls_users')
  assert.equal(slapCalls.at(-1)[0], 'updateOne')
})
