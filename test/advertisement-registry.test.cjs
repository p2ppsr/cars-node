const assert = require('node:assert/strict')
const test = require('node:test')

test('application capability inventory excludes node-owned discovery services', () => {
  const { applicationCapabilities } = require('../dist/src/advertisements/registry.js')
  assert.deepEqual(
    applicationCapabilities(
      ['tm_ship', 'tm_slap', 'tm_alpha', 'tm_alpha'],
      ['ls_ship', 'ls_slap', 'ls_alpha']
    ),
    { topicManagers: ['tm_alpha'], lookupServices: ['ls_alpha'] }
  )
})
