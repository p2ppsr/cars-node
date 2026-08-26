const assert = require('node:assert/strict')
const test = require('node:test')

const { selectAdvertisementsToRevoke } = require('../dist/src/advertisements/reconciler.js')

const desired = (protocol, domain, capability) => ({
  network: 'mainnet',
  protocol,
  domain,
  capability
})

const observed = (protocol, domain, topicOrService, identityKey = '02'.padEnd(66, '1')) => ({
  protocol,
  domain,
  topicOrService,
  identityKey
})

test('advertisement reconciliation removes stale and duplicate outputs', () => {
  const live = desired('SLAP', 'https://live.example', 'ls_example')
  const first = observed('SLAP', live.domain, live.capability)
  const duplicate = observed('SLAP', live.domain, live.capability)
  const stale = observed('SHIP', 'https://gone.example', 'tm_old')

  assert.deepEqual(
    selectAdvertisementsToRevoke([live], [first, duplicate, stale]),
    [duplicate, stale]
  )
})

test('advertisement reconciliation keeps one output per desired tuple', () => {
  const live = desired('SHIP', 'https://live.example', 'tm_example')
  const only = observed('SHIP', live.domain, live.capability)

  assert.deepEqual(selectAdvertisementsToRevoke([live, live], [only]), [])
})
