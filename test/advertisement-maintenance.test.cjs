const assert = require('node:assert/strict')
const test = require('node:test')
const { setImmediate: tick } = require('node:timers/promises')
const { MySqlLeaderLease } = require('../dist/src/advertisements/leader.js')
const { MaintenanceWorker } = require('../dist/src/maintenance-worker.js')

function connectionFixture() {
  const queries = []
  const releases = []
  let owned = 1
  let failure
  const connection = { query: async (query) => {
    queries.push(query)
    if (failure) throw failure
    return [[query.includes('IS_USED_LOCK') ? { owned } : { acquired: 1 }]]
  } }
  const db = { client: { acquireConnection: async () => connection,
    releaseConnection: async value => releases.push(value) } }
  return { db, connection, queries, releases, lose: () => { owned = 0 },
    fail: () => { failure = new Error('connection lost') } }
}

test('cached leadership is revalidated on its original SQL connection', async () => {
  const f = connectionFixture()
  const leader = new MySqlLeaderLease(f.db, 'test')
  assert.equal(await leader.acquire(), true)
  f.lose()
  assert.equal(await leader.acquire(), false)
  assert.equal(leader.isLeader, false)
  assert.equal(f.releases.length, 1)
  assert.ok(f.queries[1].includes('IS_USED_LOCK'))
})

test('a lost SQL session cannot retain leadership or a borrowed pool slot', async () => {
  const f = connectionFixture()
  const leader = new MySqlLeaderLease(f.db, 'test')
  await leader.acquire()
  f.fail()
  await assert.rejects(leader.acquire(), /connection lost/)
  assert.equal(leader.isLeader, false)
  assert.equal(f.connection.__knex__disposed, true)
  assert.deepEqual(f.releases, [f.connection])
  await leader.release()
  assert.equal(f.releases.length, 1)
})

test('shutdown waits for active work and admits no subsequent iteration', async () => {
  let finish
  let calls = 0
  const work = new Promise(resolve => { finish = resolve })
  const worker = new MaintenanceWorker(async () => { calls++; await work }, 1)
  worker.run()
  assert.equal(worker.state.active, true)
  let stopped = false
  const stop = worker.stop().then(() => { stopped = true })
  await tick()
  assert.equal(stopped, false)
  assert.equal(worker.state.stopping, true)
  finish()
  await stop
  assert.equal(calls, 1)
  assert.equal(worker.state.active, false)
  assert.equal(worker.state.nextRunAt, undefined)
})

test('shutdown interrupts the five-minute idle wait immediately', async () => {
  const worker = new MaintenanceWorker(async () => {}, 300000)
  worker.run()
  await tick()
  assert.ok(worker.state.lastCompletedAt)
  assert.ok(worker.state.nextRunAt)
  await worker.stop()
  assert.equal(worker.state.nextRunAt, undefined)
})

test('a stop before startup never admits work', async () => {
  let calls = 0
  const worker = new MaintenanceWorker(async () => { calls++ }, 1000)
  await worker.stop()
  await worker.run()
  assert.equal(calls, 0)
})
