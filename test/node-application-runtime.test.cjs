const test = require('node:test');
const assert = require('node:assert/strict');
const { nodeApplicationRuntime, generateNodeEntrypoint, generateNodePackageJson, generateNodeDockerfile } = require('../dist/src/application-runtime');
const { frontendNginxConfig } = require('../dist/src/frontend-static-routing');

test('plain Node runtime is opt-in and confined to a tenant src ESM entrypoint', () => {
  assert.equal(nodeApplicationRuntime({}), undefined);
  assert.equal(nodeApplicationRuntime({backend:{language:'typescript'}}), undefined);
  const runtime = nodeApplicationRuntime({ backend:{runtime:'node',entrypoint:'./src/server.mjs',frontendProxy:['/msc-signal/v1/','/signal-bridge.json']} });
  assert.match(generateNodeEntrypoint(runtime),/process.env.PORT = '8080'/);
  assert.match(generateNodeEntrypoint(runtime),/import\("\.\/src\/server.mjs"\)/);
  for (const entrypoint of ['../../server.mjs','./src/../server.mjs','./src/a;bad.mjs','https://example.com/x.mjs','./index.ts'])
    assert.throws(()=>nodeApplicationRuntime({backend:{runtime:'node',entrypoint}}));
  assert.throws(()=>nodeApplicationRuntime({backend:{runtime:'node',entrypoint:'./src/server.mjs'},topicManagers:{tm_x:'./src/tm.ts'}}));
  assert.throws(()=>nodeApplicationRuntime({backend:{runtime:'node',entrypoint:'./src/server.mjs',arbitrary:'configuration'}}));
});

test('Node service image keeps the fixed platform listener and runs without overlay or DB credentials', () => {
  const pkg=generateNodePackageJson({ws:'8.18.0'}), docker=generateNodeDockerfile();
  assert.equal(pkg.dependencies.ws,'8.18.0');assert.equal(pkg.scripts.start,'tsx index.ts');
  assert(!JSON.stringify(pkg).includes('overlay-express'));
  assert.match(docker,/USER node/);assert.match(docker,/EXPOSE 8080/);assert(!docker.includes('wait-for-services'));
  assert.match(docker,/--ignore-scripts/);
});

test('same-pod gateway proxy carries WebSockets without logging or retrying requests', () => {
  const ordinary=frontendNginxConfig(8080);
  assert(!ordinary.includes('proxy_pass'));
  const proxy=frontendNginxConfig(8081,undefined,['/msc-signal/v1/','/signal-bridge.json']);
  assert.match(proxy,/location \^~ \/msc-signal\/v1\//);
  assert.match(proxy,/location = \/signal-bridge.json/);
  assert.match(proxy,/proxy_pass http:\/\/127.0.0.1:8080;/);
  assert.match(proxy,/proxy_set_header Upgrade \$http_upgrade/);
  assert.match(proxy,/access_log off/);assert.match(proxy,/proxy_next_upstream off/);
  assert(proxy.includes('try_files $uri/index.html'));
  for (const path of ['/','//evil','/../x','/api; malicious','/api$arg','https://example.com'])
    assert.throws(()=>frontendNginxConfig(8081,undefined,[path]));
});
