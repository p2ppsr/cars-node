const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MongoClient } = require('mongodb');
const { buildProjectDbCredentials } = require('../dist/src/shared-db.js');

const projectId = '0123456789abcdef0123456789abcdef';

test('repeated provisioning preserves both stored passwords for a replica-set URL', () => {
  const first = buildProjectDbCredentials(projectId);
  assert.throws(() => new URL(first.mongoUrl), TypeError);
  const second = buildProjectDbCredentials(projectId, {
    KNEX_URL: first.knexUrl,
    MONGO_URL: first.mongoUrl,
  });
  assert.equal(second.mysqlPassword, first.mysqlPassword);
  assert.equal(second.mongoPassword, first.mongoPassword);
  assert.equal(second.knexUrl, first.knexUrl);
  assert.equal(second.mongoUrl, first.mongoUrl);
});

test('the Mongo driver preserves percent-encoded password bytes without connecting', () => {
  const first = buildProjectDbCredentials(projectId);
  const password = 'synthetic:/@,?#%+ secret';
  const mongoUrl = first.mongoUrl.replace(
    encodeURIComponent(first.mongoPassword), encodeURIComponent(password)
  );
  const result = buildProjectDbCredentials(projectId, {
    KNEX_URL: first.knexUrl, MONGO_URL: mongoUrl,
  });
  assert.equal(result.mongoPassword, password);
  assert.equal(new MongoClient(result.mongoUrl).options.credentials.password, password);
});

test('incomplete or malformed existing credentials fail closed without secret disclosure', () => {
  const first = buildProjectDbCredentials(projectId);
  const valid = { KNEX_URL: first.knexUrl, MONGO_URL: first.mongoUrl };
  const other = buildProjectDbCredentials('abcdef0123456789abcdef0123456789');
  const cases = [
    {}, { KNEX_URL: first.knexUrl }, { MONGO_URL: first.mongoUrl },
    { ...valid, KNEX_URL: '' }, { ...valid, MONGO_URL: '' },
    { ...valid, KNEX_URL: 'not a URL containing synthetic-secret' },
    { ...valid, MONGO_URL: 'mongodb://malformed:synthetic-secret@' },
    { ...valid, KNEX_URL: other.knexUrl }, { ...valid, MONGO_URL: other.mongoUrl },
    { ...valid, KNEX_URL: first.knexUrl.replace('shared-mysql-haproxy', 'wrong-mysql') },
    { ...valid, MONGO_URL: first.mongoUrl.replaceAll('shared-mongo-', 'wrong-mongo-') },
  ];
  for (const value of cases) {
    assert.throws(() => buildProjectDbCredentials(projectId, value), error => {
      assert.match(error.message, /refusing unsafe credential rotation/);
      assert.ok(!error.message.includes('synthetic-secret'));
      assert.ok(!error.message.includes(first.mysqlPassword));
      assert.ok(!error.message.includes(first.mongoPassword));
      return true;
    });
  }
});

test('a new project still receives independently generated database credentials', () => {
  const first = buildProjectDbCredentials(projectId);
  const second = buildProjectDbCredentials(projectId);
  assert.notEqual(first.mysqlPassword, second.mysqlPassword);
  assert.notEqual(first.mongoPassword, second.mongoPassword);
  assert.notEqual(first.mysqlPassword, first.mongoPassword);
});
