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

test('capability inspection waits for a newly rolled-out backend', async () => {
  const { inspectProjectCapabilities } = require('../dist/src/advertisements/registry.js')
  let topicAttempts = 0
  let sleeps = 0

  const capabilities = await inspectProjectCapabilities('http://project-backend', {
    attempts: 3,
    delayMs: 0,
    sleep: async () => { sleeps += 1 },
    request: async url => {
      if (url.endsWith('/listTopicManagers')) {
        topicAttempts += 1
        if (topicAttempts < 3) throw new Error('connect ECONNREFUSED')
        return { data: { tm_alpha: true, tm_ship: true } }
      }
      return { data: { ls_alpha: true, ls_slap: true } }
    }
  })

  assert.equal(topicAttempts, 3)
  assert.equal(sleeps, 2)
  assert.deepEqual(capabilities, {
    topicManagers: ['tm_alpha'],
    lookupServices: ['ls_alpha']
  })
})

test('capability inspection fails after its bounded retry window', async () => {
  const { inspectProjectCapabilities } = require('../dist/src/advertisements/registry.js')
  let attempts = 0

  await assert.rejects(
    inspectProjectCapabilities('http://project-backend', {
      attempts: 2,
      delayMs: 0,
      sleep: async () => {},
      request: async () => {
        attempts += 1
        throw new Error('backend unavailable')
      }
    }),
    /backend unavailable/
  )
  assert.equal(attempts, 4)
})
