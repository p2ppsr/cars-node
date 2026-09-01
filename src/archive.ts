import fs from 'fs-extra';
import path from 'node:path';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';

export interface ArchiveLimits {
  maxEntries: number;
  maxExpandedBytes: number;
}

const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: 50_000,
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
};

function safeArchivePath(root: string, memberName: string): string {
  if (!memberName || memberName.includes('\0') || memberName.includes('\\')) {
    throw new Error('Archive contains an invalid path');
  }
  const withoutDot = memberName.replace(/^(\.\/)+/, '');
  const segments = withoutDot.split('/');
  if (withoutDot.startsWith('/') || segments.some(segment => segment === '..' || segment === '')) {
    throw new Error(`Archive path is unsafe: ${memberName}`);
  }
  const normalized = path.posix.normalize(withoutDot);
  if (normalized === '.' || normalized.startsWith('../')) {
    throw new Error(`Archive path is unsafe: ${memberName}`);
  }
  const target = path.resolve(root, ...normalized.split('/'));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix)) {
    throw new Error(`Archive path escapes extraction root: ${memberName}`);
  }
  return target;
}

export async function extractTarGz(
  archivePath: string,
  destination: string,
  limits: ArchiveLimits = DEFAULT_LIMITS,
): Promise<{ entries: number; expandedBytes: number }> {
  await fs.remove(destination);
  await fs.ensureDir(destination, 0o700);

  const extractor = tar.extract();
  const input = fs.createReadStream(archivePath);
  const gunzip = createGunzip();
  let entries = 0;
  let expandedBytes = 0;
  const pumping = pipeline(input, gunzip, extractor);

  try {
    for await (const stream of extractor) {
      const header = stream.header;
      entries += 1;
      if (entries > limits.maxEntries) {
        throw new Error(`Archive contains more than ${limits.maxEntries} entries`);
      }
      if (header.type !== 'file' && header.type !== 'directory') {
        throw new Error(`Archive entry type is not allowed: ${header.type || 'unknown'}`);
      }
      const target = safeArchivePath(destination, header.name);
      const declaredSize = Number(header.size || 0);
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
        throw new Error(`Archive entry has an invalid size: ${header.name}`);
      }
      expandedBytes += declaredSize;
      if (expandedBytes > limits.maxExpandedBytes) {
        throw new Error(`Archive expands beyond ${limits.maxExpandedBytes} bytes`);
      }

      if (header.type === 'directory') {
        await fs.ensureDir(target, 0o755);
        for await (const _chunk of stream) { /* directory entries have no body */ }
        continue;
      }

      await fs.ensureDir(path.dirname(target), 0o755);
      let actualBytes = 0;
      const handle = await open(target, 'wx', 0o600);
      try {
        for await (const chunk of stream) {
          const value = Buffer.from(chunk as Uint8Array);
          actualBytes += value.length;
          if (actualBytes > declaredSize || actualBytes > limits.maxExpandedBytes) {
            throw new Error(`Archive entry exceeded its declared size: ${header.name}`);
          }
          await handle.write(value);
        }
      } finally {
        await handle.close();
      }
      if (actualBytes !== declaredSize) {
        throw new Error(`Archive entry size mismatch: ${header.name}`);
      }
      await fs.chmod(target, 0o644);
    }
    await pumping;
  } catch (error) {
    input.destroy();
    gunzip.destroy();
    extractor.destroy();
    await pumping.catch(() => undefined);
    await fs.remove(destination).catch(() => undefined);
    throw error;
  }
  return { entries, expandedBytes };
}

export { safeArchivePath };
