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
    () => ({ count: () => ({ first: async () => ({ count: 1 }) }) }),
    { raw: async () => [{ ok: 1 }] }
  )
  const startedAt = Date.now()
  const report = await collectSystemHealth(db, {
    mainnetWalletReady: true,
    testnetWalletReady: true,
    migrationsComplete: true
  })

  assert.ok(Date.now() - startedAt < 1000)
  assert.equal(report.status, 'degraded')
  assert.equal(report.live, true)
  assert.equal(report.ready, true)
  const kubernetes = report.checks.find((check) => check.name === 'kubernetes')
  assert.equal(kubernetes.critical, false)
  assert.equal(kubernetes.status, 'error')
})
