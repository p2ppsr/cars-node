const assert = require('node:assert/strict')
const test = require('node:test')

const { runSingletonCron } = require('../dist/src/cron.js')

function fakeDb(acquired) {
  const calls = []
  return {
    calls,
    transaction: async (callback) => callback({
      raw: async (query) => {
        calls.push(query)
        if (query.includes('GET_LOCK')) return [[{ acquired: acquired ? 1 : 0 }]]
        return [[{}]]
      },
    }),
  }
}

test('only the CARS replica holding the database advisory lock runs cron work', async () => {
  let executions = 0
  const denied = fakeDb(false)
  assert.equal(await runSingletonCron(denied, async () => { executions += 1 }), false)
  assert.equal(executions, 0)
  assert.equal(denied.calls.some(query => query.includes('RELEASE_LOCK')), false)

  const allowed = fakeDb(true)
  assert.equal(await runSingletonCron(allowed, async () => { executions += 1 }), true)
  assert.equal(executions, 1)
  assert.equal(allowed.calls.some(query => query.includes('RELEASE_LOCK')), true)
})
