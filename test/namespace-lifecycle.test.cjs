const assert = require('node:assert/strict')
const test = require('node:test')

const {
  namespaceDocument,
  bindingDocument,
  bindingIsValid,
} = require('../dist/src/namespace-lifecycle-server.js')
const { assertProjectId } = require('../dist/src/namespace-lifecycle.js')

const projectId = '0123456789abcdef0123456789abcdef'

test('lifecycle documents bind only the canonical CARS runtime identity', () => {
  const namespace = namespaceDocument(projectId)
  const binding = bindingDocument(projectId)
  assert.equal(namespace.metadata.name, `cars-project-${projectId}`)
  assert.equal(namespace.metadata.labels['cars.bsv.io/project-id'], projectId)
  assert.equal(binding.metadata.namespace, namespace.metadata.name)
  assert.equal(binding.roleRef.kind, 'ClusterRole')
  assert.equal(binding.roleRef.name, 'cars-project-runtime')
  assert.deepEqual(binding.subjects, [{
    kind: 'ServiceAccount',
    name: 'cars-operator-node',
    namespace: 'cars-operator-system',
  }])
  assert.equal(bindingIsValid(binding, projectId), true)
  binding.subjects.push({ kind: 'ServiceAccount', name: 'unexpected', namespace: 'default' })
  assert.equal(bindingIsValid(binding, projectId), false)
})

test('lifecycle rejects names outside the 32-hex project boundary', () => {
  assert.doesNotThrow(() => assertProjectId(projectId))
  assert.throws(() => assertProjectId('../kube-system'))
  assert.throws(() => assertProjectId('ABCDEF0123456789ABCDEF0123456789'))
})
