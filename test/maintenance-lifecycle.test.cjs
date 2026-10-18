const assert = require('node:assert/strict')
const test = require('node:test')
const http = require('node:http')
const { setImmediate: tick } = require('node:timers/promises')
const { DrainingTask, ActiveOperations } = require('../dist/src/maintenance-worker.js')
const { closeHttpServer } = require('../dist/src/http-server.js')
const { backgroundWorkPaused, backgroundMaintenance } = require('../dist/src/background-maintenance.js')
const { advisoryConnection } = require('../dist/src/advisory-db.js')

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('timer shutdown awaits accepted work and prevents overlap or later starts', async () => {
  const task = new DrainingTask()
  const finished = deferred()
  const running = task.run(() => finished.promise)
  assert.equal(task.state.active, true)
  assert.equal(await task.run(async () => assert.fail('overlap')), false)
  let stopped = false
  const stop = task.stop().then(() => { stopped = true })
  await tick()
  assert.equal(stopped, false)
  assert.equal(await task.run(async () => assert.fail('late start')), false)
  finished.resolve()
  assert.equal(await running, true)
  await stop
  assert.equal(task.state.active, false)
})

test('HTTP close preserves an accepted request and upload drain awaits work after 202', async () => {
  const operations = new ActiveOperations()
  const admitted = deferred(), sendResponse = deferred(), finishBuild = deferred()
  const server = http.createServer((req, res) => {
    void operations.run(async () => {
      admitted.resolve()
      await sendResponse.promise
      res.writeHead(202); res.end('accepted')
      await finishBuild.promise
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const response = new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}`, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode))
    }).once('error', reject)
  })
  await admitted.promise
  let closed = false
  const closing = closeHttpServer(server).then(() => { closed = true })
  await tick()
  assert.equal(closed, false)
  sendResponse.resolve()
  assert.equal(await response, 202)
  await closing
  let drained = false
  const drain = operations.drain().then(() => { drained = true })
  await tick()
  assert.equal(drained, false)
  assert.equal(operations.count, 1)
  finishBuild.resolve()
  await drain
  assert.equal(operations.count, 0)
})

test('background fence reports expiry without activating a competing authority', () => {
  const now = Date.parse('2026-10-18T03:00:00Z')
  assert.equal(backgroundWorkPaused('', now), false)
  assert.equal(backgroundWorkPaused('2026-10-18T03:01:00Z', now), true)
  assert.equal(backgroundWorkPaused('2026-10-18T02:59:00Z', now), true)
  assert.equal(backgroundMaintenance('2026-10-18T02:59:00Z', now).expired, true)
  for (const value of ['invalid', '2026-10-18T03:01:00+00:00', '2026-10-18T07:00:01Z']) {
    assert.throws(() => backgroundWorkPaused(value, now), /UTC deadline/)
  }
})

test('advisory authority preserves database credentials and options without logging them', () => {
  const uri = 'mysql://user:p%40ss@proxy:3306/cars?charset=utf8mb4'
  const result = new URL(advisoryConnection(uri, 'database-2.headless.svc.cluster.local'))
  assert.equal(result.hostname, 'database-2.headless.svc.cluster.local')
  assert.equal(result.password, 'p%40ss')
  assert.equal(result.pathname, '/cars')
  assert.equal(result.searchParams.get('charset'), 'utf8mb4')
  const original = { host: 'proxy', user: 'test', password: 'fixture', database: 'cars', ssl: { rejectUnauthorized: true } }
  assert.deepEqual(advisoryConnection(original, 'database-2'), { ...original, host: 'database-2' })
  assert.equal(original.host, 'proxy')
  assert.throws(() => advisoryConnection(uri, 'bad/host'), /^Error: Invalid CARS_ADVISORY_MYSQL_HOST$/)
  assert.throws(() => advisoryConnection('secret-invalid-url', 'database-2'), error => !error.message.includes('secret-invalid-url'))
})
