const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { generatePackageJson, generateDockerfile } = require('../dist/src/utils.js')

function checkGeneratedRuntime(dependencies, shouldLoad) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cars-generated-runtime-'))
  try {
    const packageJson = generatePackageJson(dependencies)
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(packageJson))
    execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: directory, timeout: 120000, stdio: 'pipe'
    })
    // Exercise the very command executed by the generated image build.
    const smokeCommand = generateDockerfile(false).match(/^RUN node --input-type=module -e "([^"]+)"$/m)
    assert.ok(smokeCommand, 'Generated image must check the ESM runtime before deployment')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', smokeCommand[1]], {
      cwd: directory, encoding: 'utf8', timeout: 30000
    })
    assert.ifError(result.error)
    if (shouldLoad) assert.equal(result.status, 0, result.stderr)
    else {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /does not provide an export named 'createPublicHTTPSFetch'/)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('generated backend preserves application pins and loads its actual ESM server', { timeout: 180000 }, () => {
  checkGeneratedRuntime({ '@bsv/sdk': '2.8.8', '@bsv/overlay': '2.6.2', mongodb: '7.6.0' }, true)
})

test('generated platform defaults load the current overlay dependency tree', { timeout: 180000 }, () => {
  checkGeneratedRuntime({}, true)
})

test('incompatible application pins fail the generated image build before rollout', { timeout: 180000 }, () => {
  checkGeneratedRuntime({ '@bsv/sdk': '2.6.0', '@bsv/overlay': '2.6.2' }, false)
})
