const assert = require('node:assert/strict')
const fs = require('node:fs')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const test = require('node:test')
const { createKubernetesNamespaceReader } = require('../dist/src/kubernetes-health.js')

test('authenticated namespace health reuses verified TLS and preserves bounded failures', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cars-api-health-'))
  const key = path.join(directory, 'server.key')
  const cert = path.join(directory, 'ca.crt')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', key, '-out', cert], { stdio: 'ignore' })
  fs.writeFileSync(path.join(directory, 'token'), 'first-token\n')
  let mode = 'ok'
  let connections = 0
  const requests = []
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization })
    if (mode === 'slow') return
    if (mode === 'forbidden') return res.writeHead(403).end('private response must not be logged')
    if (mode === 'invalid') return res.end('not-json')
    if (mode === 'large') return res.end('x'.repeat(1024 * 1024 + 1))
    res.end(JSON.stringify({ status: { phase: 'Active' } }))
  })
  server.on('secureConnection', () => connections++)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const options = { host: '127.0.0.1', port: server.address().port,
    serviceAccountDirectory: directory, timeoutMs: () => 1000 }
  const reader = createKubernetesNamespaceReader(options)
  t.after(async () => {
    reader.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await t.test('checks the same namespace with a current token over one TLS connection', async () => {
    assert.equal((await reader.read()).status.phase, 'Active')
    fs.writeFileSync(path.join(directory, 'token'), 'rotated-token\n')
    assert.equal((await reader.read()).status.phase, 'Active')
    assert.equal(connections, 1)
    assert.deepEqual(requests, [
      { method: 'GET', path: '/api/v1/namespaces/cars-operator-system', authorization: 'Bearer first-token' },
      { method: 'GET', path: '/api/v1/namespaces/cars-operator-system', authorization: 'Bearer rotated-token' }
    ])
  })
  await t.test('rejects authorization failures without returning sensitive response bodies', async () => {
    mode = 'forbidden'
    await assert.rejects(reader.read(), { message: 'Kubernetes namespace health returned HTTP 403' })
  })
  await t.test('rejects malformed and oversized responses', async () => {
    mode = 'invalid'
    await assert.rejects(reader.read(), /invalid JSON/)
    mode = 'large'
    await assert.rejects(reader.read(), /exceeded 1 MiB/)
  })
  await t.test('enforces an absolute deadline even when response data never arrives', async () => {
    mode = 'slow'
    const bounded = createKubernetesNamespaceReader({ ...options, timeoutMs: () => 100 })
    const start = Date.now()
    try { await assert.rejects(bounded.read(), /timed out/) } finally { bounded.close() }
    assert.ok(Date.now() - start < 750)
  })
  await t.test('rejects untrusted TLS rather than falling back to an insecure request', async () => {
    mode = 'ok'
    const wrong = path.join(directory, 'wrong')
    fs.mkdirSync(wrong)
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=wrong-ca', '-keyout', path.join(wrong, 'key'), '-out', path.join(wrong, 'ca.crt')], { stdio: 'ignore' })
    fs.writeFileSync(path.join(wrong, 'token'), 'test-token')
    const untrusted = createKubernetesNamespaceReader({ ...options, serviceAccountDirectory: wrong })
    try { await assert.rejects(untrusted.read(), /self-signed certificate/) } finally { untrusted.close() }
  })
})
