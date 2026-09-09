const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { collectSystemHealth } = require('../dist/src/health.js')

test('bounds Kubernetes health without removing a serving replica', async (t) => {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cars-health-'))
  const kubectl = path.join(fakeBin, 'kubectl')
  fs.writeFileSync(
    kubectl,
    '#!/usr/bin/env node\nsetTimeout(() => process.stdout.write(\'{"status":{"phase":"Active"}}\'), 2000)\n'
  )
  fs.chmodSync(kubectl, 0o755)

  const originalPath = process.env.PATH
  const originalTimeout = process.env.CARS_KUBERNETES_HEALTH_TIMEOUT_MS
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`
  process.env.CARS_KUBERNETES_HEALTH_TIMEOUT_MS = '100'
  t.after(() => {
    process.env.PATH = originalPath
    if (originalTimeout === undefined) {
      delete process.env.CARS_KUBERNETES_HEALTH_TIMEOUT_MS
    } else {
      process.env.CARS_KUBERNETES_HEALTH_TIMEOUT_MS = originalTimeout
    }
    fs.rmSync(fakeBin, { recursive: true, force: true })
  })

  const db = Object.assign(
    () => ({
      count: () => ({ first: async () => ({ count: 1 }) }),
      select: async () => [{ project_uuid: '0123456789abcdef0123456789abcdef' }],
    }),
    { raw: async () => [{ ok: 1 }] }
  )
  const startedAt = Date.now()
  const report = await collectSystemHealth(db, {
    mainnetWalletReady: true,
    testnetWalletReady: true,
    migrationsComplete: true,
    namespaceLifecycleCheck: async () => ({
      status: 'ok',
      expectedProjects: 1,
      managedNamespaces: 1,
      missingNamespaces: [],
      orphanNamespaces: [],
      invalidBindings: [],
    })
  })

  assert.ok(Date.now() - startedAt < 1000)
  assert.equal(report.status, 'error')
  assert.equal(report.live, true)
  assert.equal(report.ready, false)
  const kubernetes = report.checks.find((check) => check.name === 'kubernetes')
  assert.equal(kubernetes.critical, true)
  assert.equal(kubernetes.readinessCritical, true)
  assert.equal(kubernetes.livenessCritical, false)
  assert.equal(kubernetes.status, 'error')
})

test('keeps readiness during a bounded Kubernetes health-check transient', async (t) => {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cars-health-grace-'))
  const kubectl = path.join(fakeBin, 'kubectl')
  const failMarker = path.join(fakeBin, 'fail')
  fs.writeFileSync(
    kubectl,
    `#!/usr/bin/env node
const fs = require('node:fs')
if (fs.existsSync(${JSON.stringify(failMarker)})) process.exit(1)
process.stdout.write('{"status":{"phase":"Active"}}')
`
  )
  fs.chmodSync(kubectl, 0o755)

  const originalPath = process.env.PATH
  const originalTimeout = process.env.CARS_KUBERNETES_HEALTH_TIMEOUT_MS
  const originalGrace = process.env.CARS_KUBERNETES_HEALTH_FAILURE_GRACE_MS
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`
  process.env.CARS_KUBERNETES_HEALTH_TIMEOUT_MS = '500'
  process.env.CARS_KUBERNETES_HEALTH_FAILURE_GRACE_MS = '200'
  t.after(() => {
    process.env.PATH = originalPath
    for (const [name, value] of [
      ['CARS_KUBERNETES_HEALTH_TIMEOUT_MS', originalTimeout],
      ['CARS_KUBERNETES_HEALTH_FAILURE_GRACE_MS', originalGrace],
    ]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    fs.rmSync(fakeBin, { recursive: true, force: true })
  })

  const db = Object.assign(
    () => ({
      count: () => ({ first: async () => ({ count: 1 }) }),
      select: async () => [{ project_uuid: '0123456789abcdef0123456789abcdef' }],
    }),
    { raw: async () => [{ ok: 1 }] }
  )
  const options = {
    mainnetWalletReady: true,
    testnetWalletReady: true,
    migrationsComplete: true,
    namespaceLifecycleCheck: async () => ({
      status: 'ok',
      expectedProjects: 1,
      managedNamespaces: 1,
      missingNamespaces: [],
      orphanNamespaces: [],
      invalidBindings: [],
    }),
    buildControllerCheck: async () => ({ status: 'ok' })
  }

  const healthy = await collectSystemHealth(db, options)
  assert.equal(healthy.status, 'ok')
  fs.writeFileSync(failMarker, 'fail')

  const transient = await collectSystemHealth(db, options)
  assert.equal(transient.status, 'degraded')
  assert.equal(transient.ready, true)
  const transientKubernetes = transient.checks.find((check) => check.name === 'kubernetes')
  assert.equal(transientKubernetes.status, 'degraded')
  assert.equal(transientKubernetes.readinessCritical, true)
  assert.equal(transientKubernetes.details.failureGraceMs, 200)

  await new Promise(resolve => setTimeout(resolve, 250))
  const sustained = await collectSystemHealth(db, options)
  assert.equal(sustained.status, 'error')
  assert.equal(sustained.ready, false)
  assert.equal(sustained.live, true)
  assert.equal(sustained.checks.find((check) => check.name === 'kubernetes').status, 'error')
})

test('namespace drift blocks readiness without turning liveness into a restart loop', async () => {
  const db = Object.assign(
    () => ({
      count: () => ({ first: async () => ({ count: 1 }) }),
      select: async () => [{ project_uuid: '0123456789abcdef0123456789abcdef' }],
    }),
    { raw: async () => [{ ok: 1 }] }
  )
  const report = await collectSystemHealth(db, {
    mainnetWalletReady: true,
    testnetWalletReady: true,
    migrationsComplete: true,
    namespaceLifecycleCheck: async () => ({
      status: 'error',
      expectedProjects: 1,
      managedNamespaces: 0,
      missingNamespaces: ['cars-project-0123456789abcdef0123456789abcdef'],
      orphanNamespaces: [],
      invalidBindings: [],
    })
  })
  assert.equal(report.status, 'error')
  assert.equal(report.live, true)
  assert.equal(report.ready, false)
})
