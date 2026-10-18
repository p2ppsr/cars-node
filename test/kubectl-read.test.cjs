const assert = require('node:assert/strict')
const test = require('node:test')
const { runKubectlRead } = require('../dist/src/kubectl-read.js')

test('read retries transient API withdrawal and returns the fresh result', async () => {
  let calls = 0, now = 0
  const args = ['get', 'namespaces', '-o', 'json']
  const actual = await runKubectlRead(args, async (seen, input, timeout) => {
    assert.equal(seen, args); assert.equal(input, undefined); assert.equal(timeout, 2000)
    if (++calls < 3) throw new Error('The connection to the server 10.152.183.1:443 was refused - did you specify the right host or port?')
    return '{"items":[]}'
  }, () => now, async ms => { now += ms })
  assert.equal(actual, '{"items":[]}'); assert.equal(calls, 3); assert.equal(now, 500)
})

test('read retry has one eight-second budget and retains its final failure', async () => {
  let calls = 0, now = 0
  const failure = new Error('kubectl get failed (signal SIGTERM): ')
  await assert.rejects(runKubectlRead(['get', 'namespaces'], async (_, input, timeout) => {
    assert.equal(input, undefined); assert.ok(timeout > 0 && timeout <= 2000)
    calls++; now += timeout; throw failure
  }, () => now, async ms => { now += ms }), error => error === failure)
  assert.equal(now, 8000); assert.equal(calls, 4)
})

test('mutations and unbounded raw/watch commands never execute', async () => {
  for (const args of [['apply', '-f', '-'], ['delete', 'namespace', 'x'], ['patch', 'namespace', 'x'], ['get', '--raw=/readyz'], ['get', 'pods', '--watch']]) {
    await assert.rejects(runKubectlRead(args, async () => { assert.fail('unsafe execution') }), /read-only/)
  }
})

test('authorization, missing resources and malformed results are not transient', async () => {
  for (const message of ['Forbidden', 'Unauthorized', 'NotFound', 'invalid JSON', 'namespace drift']) {
    let calls = 0
    await assert.rejects(runKubectlRead(['get', 'namespaces'], async () => { calls++; throw new Error(message) }), new RegExp(message))
    assert.equal(calls, 1)
  }
  assert.equal(await runKubectlRead(['auth', 'can-i', 'delete', 'namespaces'], async () => 'no'), 'no')
})
