const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createGzip } = require('node:zlib');
const tar = require('tar-stream');
const test = require('node:test');

const { extractTarGz, safeArchivePath } = require('../dist/src/archive.js');

async function archive(entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cars-archive-test-'));
  const archivePath = path.join(dir, 'input.tgz');
  const pack = tar.pack();
  for (const entry of entries) {
    await new Promise((resolve, reject) => {
      pack.entry(entry.header, entry.body || '', error => error ? reject(error) : resolve());
    });
  }
  pack.finalize();
  await pipeline(pack, createGzip(), require('node:fs').createWriteStream(archivePath));
  return { dir, archivePath, output: path.join(dir, 'output') };
}

test('extracts regular deployment files inside the destination', async t => {
  const fixture = await archive([
    { header: { name: 'deployment-info.json', type: 'file' }, body: '{}' },
    { header: { name: 'frontend/index.html', type: 'file' }, body: 'ok' },
  ]);
  t.after(() => fs.rm(fixture.dir, { recursive: true, force: true }));
  const report = await extractTarGz(fixture.archivePath, fixture.output, {
    maxEntries: 10,
    maxExpandedBytes: 1024,
  });
  assert.equal(report.entries, 2);
  assert.equal(await fs.readFile(path.join(fixture.output, 'frontend/index.html'), 'utf8'), 'ok');
});

test('ignores only a harmless directory marker for the archive root', async t => {
  const fixture = await archive([
    { header: { name: './', type: 'directory' } },
    { header: { name: './frontend/', type: 'directory' } },
    { header: { name: './frontend/index.html', type: 'file' }, body: 'ok' },
  ]);
  t.after(() => fs.rm(fixture.dir, { recursive: true, force: true }));
  const report = await extractTarGz(fixture.archivePath, fixture.output, {
    maxEntries: 10,
    maxExpandedBytes: 1024,
  });
  assert.equal(report.entries, 3);
  assert.equal(await fs.readFile(path.join(fixture.output, 'frontend/index.html'), 'utf8'), 'ok');
  assert.throws(() => safeArchivePath(fixture.output, './'), /unsafe/);
});

test('directory compatibility does not weaken file or directory boundaries', async t => {
  const trailingFile = await archive([{ header: { name: 'frontend/', type: 'file' }, body: 'bad' }]);
  const traversalDirectory = await archive([{ header: { name: 'frontend/../../', type: 'directory' } }]);
  t.after(() => Promise.all([
    fs.rm(trailingFile.dir, { recursive: true, force: true }),
    fs.rm(traversalDirectory.dir, { recursive: true, force: true }),
  ]));
  await assert.rejects(
    extractTarGz(trailingFile.archivePath, trailingFile.output, { maxEntries: 10, maxExpandedBytes: 1024 }),
    /unsafe/,
  );
  await assert.rejects(
    extractTarGz(traversalDirectory.archivePath, traversalDirectory.output, { maxEntries: 10, maxExpandedBytes: 1024 }),
    /unsafe|escapes/,
  );
});

test('rejects traversal and link entries', async t => {
  const traversal = await archive([{ header: { name: '../escape', type: 'file' }, body: 'bad' }]);
  const symlink = await archive([{ header: { name: 'frontend/link', type: 'symlink', linkname: '/etc/passwd' } }]);
  t.after(() => Promise.all([
    fs.rm(traversal.dir, { recursive: true, force: true }),
    fs.rm(symlink.dir, { recursive: true, force: true }),
  ]));
  await assert.rejects(
    extractTarGz(traversal.archivePath, traversal.output, { maxEntries: 10, maxExpandedBytes: 1024 }),
    /unsafe|escapes/,
  );
  await assert.rejects(
    extractTarGz(symlink.archivePath, symlink.output, { maxEntries: 10, maxExpandedBytes: 1024 }),
    /not allowed/,
  );
});

test('rejects archive expansion beyond the configured ceiling', async t => {
  const fixture = await archive([{ header: { name: 'large.bin', type: 'file' }, body: '1234567890' }]);
  t.after(() => fs.rm(fixture.dir, { recursive: true, force: true }));
  await assert.rejects(
    extractTarGz(fixture.archivePath, fixture.output, { maxEntries: 10, maxExpandedBytes: 5 }),
    /expands beyond/,
  );
});
