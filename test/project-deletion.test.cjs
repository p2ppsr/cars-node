const assert = require('node:assert/strict')
const test = require('node:test')
const { activeDeletionIds, DELETION_TRANSITION_MS, requestProjectDeletion, completeProjectDeletion } = require('../dist/src/project-deletion.js')
const { namespaceInventoryReport, namespaceDocument, bindingDocument, networkPolicyDocument } = require('../dist/src/namespace-lifecycle-server.js')
const projectId = '0123456789abcdef0123456789abcdef'
const otherId = 'abcdef0123456789abcdef0123456789'
const empty = { items: [] }

function fakeDb({ approved = true, locked = false, cleanupFailure = false, activeDeployment = false } = {}) {
  const state = { project: { id: 1, project_uuid: projectId, name: 'test', deletion_requested_at: approved ? new Date() : null }, deleted: [], releases: 0, cleanupFailure }
  const db = table => {
    let requiresNull = false
    const query = {
      where() { return query }, forUpdate() { return query }, whereIn() { return query }, whereNull() { requiresNull = true; return query }, join() { return query },
      async first() { if (table === 'deploys') return activeDeployment ? { id: 2 } : undefined; return state.project ? { ...state.project } : undefined },
      async select() { return [] },
      async update(values) { if (state.project && (!requiresNull || !state.project.deletion_requested_at)) Object.assign(state.project, values); return 1 },
      async del() {
        if (state.cleanupFailure) { state.cleanupFailure = false; throw Error('database interrupted') }
        state.deleted.push(table)
        if (table === 'projects') state.project = null
      },
    }
    return query
  }
  db.raw = async sql => {
    if (sql.includes('GET_LOCK')) return [[{ acquired: locked ? 0 : 1 }]]
    state.releases++
    return [[{}]]
  }
  db.transaction = async callback => callback(db)
  db.fn = { now: () => new Date() }
  return { db, state }
}

test('only a recent, nonfuture, explicit deletion enters the five-minute transition', () => {
  const now = Date.now()
  for (const timestamp of [null, 'invalid', new Date(now + 1), new Date(now - DELETION_TRANSITION_MS)]) {
    assert.deepEqual(activeDeletionIds([{ project_uuid: projectId, deletion_requested_at: timestamp }], now), [])
  }
  assert.deepEqual(activeDeletionIds([{ project_uuid: projectId, deletion_requested_at: new Date(now - 1) }], now), [projectId])
})

test('repeating an authorized deletion preserves its original deadline', async () => {
  const { db, state } = fakeDb()
  const before = state.project.deletion_requested_at
  await requestProjectDeletion(db, projectId, 'admin')
  assert.equal(state.project.deletion_requested_at, before)
})

test('namespace timeout preserves durable intent and resumes after a lost response', async () => {
  const { db, state } = fakeDb()
  let namespaceExists = true
  let notifications = 0
  const notify = async () => { notifications++ }
  await assert.rejects(completeProjectDeletion(db, projectId, async () => {
    namespaceExists = false
    throw Error('response timed out after namespace deletion')
  }, notify), /timed out/)
  assert.equal(namespaceExists, false)
  assert.ok(state.project.deletion_requested_at)
  assert.deepEqual(state.deleted, [])
  assert.equal(state.releases, 1)
  assert.equal(await completeProjectDeletion(db, projectId, async () => {
    assert.equal(namespaceExists, false) // idempotent confirmation on the next worker
  }, notify), true)
  assert.equal(state.project, null)
  assert.equal(state.deleted.at(-1), 'projects')
  assert.equal(notifications, 1)
})

test('failed database cleanup retains intent for reconciliation', async () => {
  const { db, state } = fakeDb({ cleanupFailure: true })
  await assert.rejects(completeProjectDeletion(db, projectId, async () => {}, async () => {}), /database interrupted/)
  assert.ok(state.project.deletion_requested_at)
  await completeProjectDeletion(db, projectId, async () => {}, async () => {})
  assert.equal(state.project, null)
})

test('another replica holding the deletion lock prevents duplicate work', async () => {
  const { db } = fakeDb({ locked: true })
  assert.equal(await completeProjectDeletion(db, projectId, async () => { assert.fail('must not delete') }), false)
})

test('a worker cannot delete a project without persisted authorization', async () => {
  const { db } = fakeDb({ approved: false })
  await assert.rejects(completeProjectDeletion(db, projectId, async () => { assert.fail('must not delete') }), /not been authorized/)
})

test('deleted projects are idempotent and notification failure cannot restore them', async () => {
  const { db, state } = fakeDb()
  assert.equal(await completeProjectDeletion(db, projectId, async () => {}, async () => { throw Error('email down') }), true)
  assert.equal(state.project, null)
  assert.equal(await completeProjectDeletion(db, projectId, async () => { assert.fail('already gone') }), true)
})

test('expected teardown can remove bindings and namespace without masking unrelated drift', () => {
  const namespaces = { items: [namespaceDocument(projectId)] }
  assert.equal(namespaceInventoryReport([projectId], [projectId], namespaces, empty, empty).status, 'ok')
  assert.equal(namespaceInventoryReport([projectId], [projectId], empty, empty, empty).status, 'ok')
  assert.equal(namespaceInventoryReport([projectId], [], empty, empty, empty).status, 'error')
  assert.equal(namespaceInventoryReport([projectId, otherId], [projectId], empty, empty, empty).status, 'error')
  assert.throws(() => namespaceInventoryReport([projectId], [otherId], empty, empty, empty), /expected project/)
})

test('deletion never waives malformed present bindings, policies, labels, or orphan namespaces', () => {
  const namespace = namespaceDocument(projectId)
  const binding = bindingDocument(projectId)
  const policy = networkPolicyDocument(projectId)
  binding.roleRef.name = 'unexpected-role'
  assert.equal(namespaceInventoryReport([projectId], [projectId], { items: [namespace] }, { items: [binding] }, { items: [policy] }).status, 'error')
  policy.spec.egress = []
  assert.equal(namespaceInventoryReport([projectId], [projectId], { items: [namespace] }, empty, { items: [policy] }).status, 'error')
  delete namespace.metadata.labels['cars.bsv.io/project-id']
  assert.equal(namespaceInventoryReport([projectId], [projectId], { items: [namespace] }, empty, empty).status, 'error')
  assert.equal(namespaceInventoryReport([projectId], [projectId], { items: [namespaceDocument(otherId)] }, empty, empty).status, 'error')
})

test('active uploads block deletion before intent or namespace changes', async () => {
  const { db, state } = fakeDb({ approved: false, activeDeployment: true })
  await assert.rejects(requestProjectDeletion(db, projectId, 'admin'), /active deployment/)
  assert.equal(state.project.deletion_requested_at, null)
  assert.deepEqual(state.deleted, [])
})
