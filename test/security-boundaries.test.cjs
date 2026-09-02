const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { authorizeTakedown, takedownOperationId } = require('../dist/src/routes/globalEviction.js');
const { KnexPaymentReplayStore } = require('../dist/src/payment-replay.js');
const { deploymentWorkspaceRoot } = require('../dist/src/deployment-workspace.js');

const officers = [`02${'11'.repeat(32)}`, `03${'22'.repeat(32)}`];
const authority = [{ name: 'court', authorityRequiredSignatures: 2, officerIdentityKeys: officers }];
const baseTakedown = {
  authority: 'court',
  authorityRequiredSignatures: 2,
  outpoint: `${'aa'.repeat(32)}.0`,
  takedownNumber: 'T-1',
  humanReadableMessage: 'authorized',
};
const signature = 'bb'.repeat(64);

test('takedown threshold counts only distinct configured officers', async () => {
  const duplicate = {
    ...baseTakedown,
    signatures: [
      { officerIdentityKey: officers[0], officerSignature: signature },
      { officerIdentityKey: officers[0], officerSignature: signature },
    ],
  };
  assert.equal(await authorizeTakedown(duplicate, authority, async () => true), false);

  const unique = {
    ...baseTakedown,
    signatures: officers.map(officerIdentityKey => ({ officerIdentityKey, officerSignature: signature })),
  };
  assert.equal(await authorizeTakedown(unique, authority, async () => true), true);
});

test('takedown threshold ignores valid signatures from unconfigured identities', async () => {
  const notice = {
    ...baseTakedown,
    signatures: [
      { officerIdentityKey: officers[0], officerSignature: signature },
      { officerIdentityKey: `02${'33'.repeat(32)}`, officerSignature: signature },
    ],
  };
  assert.equal(await authorizeTakedown(notice, authority, async () => true), false);
});

test('takedown replay identity is stable and binds every signed action field', () => {
  const first = takedownOperationId({ ...baseTakedown, signatures: [] });
  assert.equal(first, takedownOperationId({ ...baseTakedown, signatures: [] }));
  assert.notEqual(first, takedownOperationId({ ...baseTakedown, outpoint: `${'ab'.repeat(32)}.0`, signatures: [] }));
  assert.notEqual(first, takedownOperationId({ ...baseTakedown, humanReadableMessage: 'different', signatures: [] }));
});

test('payment replay claims use one atomic insert and reject duplicates', async () => {
  const claimed = new Set();
  const database = () => ({
    insert: async row => {
      if (claimed.has(row.transaction_id)) {
        const error = new Error('duplicate');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      claimed.add(row.transaction_id);
    },
  });
  const store = new KnexPaymentReplayStore(database);
  const txid = 'ab'.repeat(32);
  assert.equal(await store.claim(txid), true);
  assert.equal(await store.claim(txid), false);
  await assert.rejects(store.claim('not-a-txid'), /Invalid payment transaction id/);
});

test('release source removes shell builds and separates the build controller', () => {
  const upload = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'upload.ts'), 'utf8');
  const builder = fs.readFileSync(path.join(__dirname, '..', 'src', 'build-controller-server.ts'), 'utf8');
  assert.doesNotMatch(upload, /shell:\s*true|tar -x|buildah build/);
  assert.match(upload, /verifySignature[\s\S]*writeUploadToFile/);
  assert.match(upload, /status: 'uploading'/);
  assert.match(upload, /extractTarGz/);
  assert.match(upload, /maxUnavailable: 0/);
  assert.match(upload, /startupProbe:[\s\S]*httpGet:[\s\S]*failureThreshold: 30/);
  assert.match(upload, /requests:[\s\S]*cpu: 100m[\s\S]*memory: 256Mi[\s\S]*limits:[\s\S]*memory: 2Gi/);
  assert.match(upload, /requests:[\s\S]*cpu: 100m[\s\S]*memory: 64Mi[\s\S]*limits:[\s\S]*memory: 512Mi/);
  assert.match(builder, /127\.0\.0\.1/);
  assert.match(builder, /--cap-drop=all/);
  assert.match(builder, /--digestfile/);
  assert.match(builder, /@\$\{digest\}/);
});

test('deployment scratch paths are opaque and bound to both tenant identifiers', () => {
  const previous = process.env.CARS_BUILD_CONTROLLER_TOKEN;
  process.env.CARS_BUILD_CONTROLLER_TOKEN = 'workspace-test-secret-that-is-long-enough';
  try {
    const projectId = '11'.repeat(16);
    const deploymentId = '22'.repeat(16);
    const root = deploymentWorkspaceRoot(projectId, deploymentId);
    assert.match(root, /^\/tmp\/cars-workspace-[a-f0-9]{64}$/);
    assert.doesNotMatch(root, new RegExp(projectId));
    assert.doesNotMatch(root, new RegExp(deploymentId));
    assert.notEqual(root, deploymentWorkspaceRoot('33'.repeat(16), deploymentId));
    assert.notEqual(root, deploymentWorkspaceRoot(projectId, '44'.repeat(16)));
    assert.throws(() => deploymentWorkspaceRoot('../tenant', deploymentId), /Invalid project id/);
  } finally {
    if (previous === undefined) delete process.env.CARS_BUILD_CONTROLLER_TOKEN;
    else process.env.CARS_BUILD_CONTROLLER_TOKEN = previous;
  }
});

test('runtime cluster tools are rebuilt from pinned modules with patched dependencies', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  const helmModule = fs.readFileSync(path.join(__dirname, '..', 'tools', 'helm', 'go.mod'), 'utf8');
  const kubectlModule = fs.readFileSync(path.join(__dirname, '..', 'tools', 'kubectl', 'go.mod'), 'utf8');
  assert.match(dockerfile, /GO_VERSION=1\.26\.6/);
  assert.match(dockerfile, /go mod verify/);
  assert.match(dockerfile, /v1\.34\.11\+cars\.1/);
  assert.match(dockerfile, /v4\.2\.4\+cars-patched-go1\.26\.6/);
  assert.doesNotMatch(dockerfile, /dl\.k8s\.io\/release|linux-amd64\/helm/);
  assert.match(helmModule, /helm\.sh\/helm\/v4 v4\.2\.4/);
  assert.match(helmModule, /golang\.org\/x\/crypto v0\.55\.0/);
  assert.match(helmModule, /oras\.land\/oras-go\/v2 v2\.6\.2/);
  assert.match(kubectlModule, /k8s\.io\/kubectl v0\.34\.11/);
});
