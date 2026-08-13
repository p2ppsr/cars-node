const assert = require('node:assert/strict');
const test = require('node:test');

const { disableRequestTimeout } = require('../dist/src/http-server.js');

test('disables the Node HTTP whole-request timeout', () => {
  const server = { requestTimeout: 300_000 };

  disableRequestTimeout(server);

  assert.equal(server.requestTimeout, 0);
});
