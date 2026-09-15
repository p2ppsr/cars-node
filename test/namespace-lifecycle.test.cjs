const assert = require('node:assert/strict')
const test = require('node:test')

const {
  namespaceDocument,
  bindingDocument,
  networkPolicyDocument,
  bindingIsValid,
  namespaceIsValid,
  networkPolicyIsValid,
} = require('../dist/src/namespace-lifecycle-server.js')
const { assertProjectId } = require('../dist/src/namespace-lifecycle.js')

const projectId = '0123456789abcdef0123456789abcdef'

test('lifecycle documents bind only the canonical CARS runtime identity', () => {
  const namespace = namespaceDocument(projectId)
  const binding = bindingDocument(projectId)
  const policy = networkPolicyDocument(projectId)
  assert.equal(namespace.metadata.name, `cars-project-${projectId}`)
  assert.equal(namespace.metadata.labels['cars.bsv.io/project-id'], projectId)
  assert.equal(namespace.metadata.labels['pod-security.kubernetes.io/enforce'], 'baseline')
  assert.equal(namespace.metadata.labels['pod-security.kubernetes.io/audit'], 'restricted')
  assert.equal(namespaceIsValid(namespace, projectId), true)
  assert.equal(binding.metadata.namespace, namespace.metadata.name)
  assert.equal(binding.roleRef.kind, 'ClusterRole')
  assert.equal(binding.roleRef.name, 'cars-project-runtime')
  assert.deepEqual(binding.subjects, [{
    kind: 'ServiceAccount',
    name: 'cars-operator-node',
    namespace: 'cars-operator-system',
  }])
  assert.equal(bindingIsValid(binding, projectId), true)
  assert.equal(policy.metadata.name, 'cars-tenant-baseline')
  assert.equal(policy.metadata.namespace, namespace.metadata.name)
  assert.deepEqual(policy.spec.podSelector, {})
  assert.deepEqual(policy.spec.policyTypes, ['Ingress', 'Egress'])
  assert.equal(policy.spec.egress.some(rule => rule.to?.some(peer => peer.ipBlock?.cidr === '0.0.0.0/0')), true)
  assert.equal(policy.spec.egress.some(rule => rule.ports?.some(port => port.port === 3306)), true)
  assert.equal(policy.spec.egress.some(rule => rule.ports?.some(port => port.port === 27017)), true)
  assert.equal(networkPolicyIsValid(policy, projectId), true)
  policy.spec.egress[policy.spec.egress.length - 1].ports.push({ protocol: 'TCP', port: 22 })
  assert.equal(networkPolicyIsValid(policy, projectId), false)
  binding.subjects.push({ kind: 'ServiceAccount', name: 'unexpected', namespace: 'default' })
  assert.equal(bindingIsValid(binding, projectId), false)
  delete namespace.metadata.labels['pod-security.kubernetes.io/enforce']
  assert.equal(namespaceIsValid(namespace, projectId), false)
})

test('lifecycle rejects names outside the 32-hex project boundary', () => {
  assert.doesNotThrow(() => assertProjectId(projectId))
  assert.throws(() => assertProjectId('../kube-system'))
  assert.throws(() => assertProjectId('ABCDEF0123456789ABCDEF0123456789'))
})
