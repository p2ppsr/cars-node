const assert = require('node:assert/strict')
const test = require('node:test')
const { namespaceDocument, bindingDocument, networkPolicyDocument, namespaceInventoryReport, NAMESPACE_CREATION_TRANSITION_MS } = require('../dist/src/namespace-lifecycle-server.js')
const id = '0123456789abcdef0123456789abcdef'
const other = 'abcdef0123456789abcdef0123456789'
const now = Date.parse('2026-11-04T20:00:00.000Z')
const empty = { items: [] }
function pending(project = id) {
  const ns = namespaceDocument(project)
  ns.metadata.creationTimestamp = new Date(now - 100).toISOString()
  return ns
}
function audit(ids, namespaces, bindings = [], policies = [], at = now) {
  return namespaceInventoryReport(ids, [], { items: namespaces }, { items: bindings }, { items: policies }, at)
}

test('creation before SQL commit stays ready, then committed projects require their full security boundary', () => {
  const ns = pending()
  let report = audit([], [ns]) // namespace exists; transaction has not committed
  assert.equal(report.status, 'ok')
  assert.deepEqual(report.creatingNamespaces, [ns.metadata.name])
  assert.deepEqual(report.orphanNamespaces, [])
  assert.equal(audit([id], [ns]).status, 'error') // SQL commit never waives binding/policy checks
  report = audit([id], [ns], [bindingDocument(id)], [networkPolicyDocument(id)])
  assert.equal(report.status, 'ok')
  assert.deepEqual(report.creatingNamespaces, [])
  assert.equal(audit([id], [ns], [bindingDocument(id)], [networkPolicyDocument(id)], now + NAMESPACE_CREATION_TRANSITION_MS).status, 'ok')
})

test('pending creation permits absent resources but rejects malformed present security resources', () => {
  const ns = pending(), binding = bindingDocument(id), policy = networkPolicyDocument(id)
  binding.roleRef.name = 'unexpected-role'
  assert.equal(audit([], [ns], [binding]).status, 'error')
  policy.spec.egress = []
  assert.equal(audit([], [ns], [], [policy]).status, 'error')
})

test('parallel creation snapshots do not suppress unrelated, expired, or malformed drift', () => {
  const a = pending(), b = pending(other)
  assert.equal(audit([], [a, b]).status, 'ok')
  delete b.metadata.annotations['cars.bsv.io/creation-intent']
  const mixed = audit([], [a, b])
  assert.equal(mixed.status, 'error')
  assert.deepEqual(mixed.orphanNamespaces, [b.metadata.name])
  b.metadata.annotations['cars.bsv.io/creation-intent'] = 'v1'
  b.metadata.creationTimestamp = new Date(now - NAMESPACE_CREATION_TRANSITION_MS).toISOString()
  assert.equal(audit([], [a, b]).status, 'error')
  assert.equal(audit([other], [a]).status, 'error') // unrelated missing project
  delete a.metadata.labels['pod-security.kubernetes.io/enforce']
  assert.equal(audit([], [a]).status, 'error')
})

test('only explicit, valid, nonfuture creation intent has an immutable deadline', () => {
  for (const stamp of [undefined, '', 'invalid', new Date(now + 1).toISOString(), new Date(now - NAMESPACE_CREATION_TRANSITION_MS).toISOString()]) {
    const ns = pending(); ns.metadata.creationTimestamp = stamp
    assert.equal(audit([], [ns]).status, 'error', String(stamp))
  }
  for (const marker of [undefined, '', 'v2']) {
    const ns = pending(); ns.metadata.annotations['cars.bsv.io/creation-intent'] = marker
    assert.equal(audit([], [ns]).status, 'error')
  }
  const ns = pending()
  assert.equal(audit([], [ns]).status, 'ok')
  // Reapplying the same intent after a worker restart cannot renew Kubernetes creationTimestamp.
  ns.metadata.annotations = namespaceDocument(id).metadata.annotations
  assert.equal(audit([], [ns], [], [], now + NAMESPACE_CREATION_TRANSITION_MS).status, 'error')
})
