import axios from 'axios';
import { KeyDeriver, PrivateKey, Transaction, type TaggedBEEF } from '@bsv/sdk';
import type { Advertisement } from '@bsv/overlay';
import { WalletAdvertiser } from '@bsv/overlay-discovery-services';
import db from '../db';
import logger from '../logger';
import { normalizeProjectNetwork, projectNetworkToWalletChain, storageUrlForChain } from '../network';
import { PassiveAdvertiser } from '../advertisements/passive-advertiser';

const controllerUrl = process.env.ADVERTISEMENT_CONTROLLER_URL ||
  'http://cars-advertisement-controller.cars-operator-system.svc.cluster.local:8081';
const parser = new PassiveAdvertiser();

async function lookup(identityKey: string, protocol: 'SHIP' | 'SLAP'): Promise<Advertisement[]> {
  const response = await axios.post(`${controllerUrl}/lookup`, {
    service: protocol === 'SHIP' ? 'ls_ship' : 'ls_slap',
    query: { identityKey, limit: 10_000 },
  }, { timeout: 60_000 });
  if (response.data?.type !== 'output-list') return [];
  const advertisements: Advertisement[] = [];
  for (const output of response.data.outputs || []) {
    const beef = Array.isArray(output.beef) ? output.beef : Array.from(Buffer.from(output.beef?.data || []));
    const tx = Transaction.fromBEEF(beef);
    const advertisement = parser.parseAdvertisement(tx.outputs[output.outputIndex].lockingScript);
    advertisements.push({ ...advertisement, beef, outputIndex: output.outputIndex });
  }
  return advertisements;
}

async function submit(taggedBEEF: TaggedBEEF): Promise<void> {
  await axios.post(`${controllerUrl}/submit`, Buffer.from(taggedBEEF.beef), {
    timeout: 120_000,
    headers: {
      'content-type': 'application/octet-stream',
      'x-topics': JSON.stringify(taggedBEEF.topics),
    },
    maxBodyLength: Infinity,
  });
}

async function verifyNodeCoverage(nodeIdentityKey: string): Promise<void> {
  const desired = await db('cars_advertised_capabilities')
    .select('protocol', 'domain', 'capability')
    .where({ active: true });
  const observed = [
    ...await lookup(nodeIdentityKey, 'SHIP'),
    ...await lookup(nodeIdentityKey, 'SLAP'),
  ];
  const observedKeys = new Set(observed.map(ad => `${ad.protocol}\u0000${ad.domain}\u0000${ad.topicOrService}`));
  const missing = desired.filter(ad => !observedKeys.has(`${ad.protocol}\u0000${ad.domain}\u0000${ad.capability}`));
  if (missing.length) {
    throw new Error(`Refusing legacy revocation: node identity is missing ${missing.length} desired advertisements`);
  }
}

async function main() {
  const execute = process.argv.includes('--execute');
  const nodePrivateKey = process.env.CARS_ADVERTISEMENT_PRIVATE_KEY;
  if (!nodePrivateKey) throw new Error('CARS_ADVERTISEMENT_PRIVATE_KEY is required');
  const nodeIdentityKey = new KeyDeriver(new PrivateKey(nodePrivateKey, 'hex')).identityKey;
  await db.migrate.latest();
  await verifyNodeCoverage(nodeIdentityKey);

  const projects = await db('projects')
    .select('id', 'project_uuid', 'network', 'private_key')
    .whereNotNull('private_key')
    .orderBy('id');
  let advertisementCount = 0;
  for (const project of projects) {
    const identityKey = new KeyDeriver(new PrivateKey(project.private_key, 'hex')).identityKey;
    const advertisements = [
      ...await lookup(identityKey, 'SHIP'),
      ...await lookup(identityKey, 'SLAP'),
    ];
    advertisementCount += advertisements.length;
    logger.info({ projectId: project.project_uuid, advertisements: advertisements.length }, execute ? 'Revoking legacy advertisements' : 'Legacy advertisement revoke preview');
    if (!execute || advertisements.length === 0) {
      if (execute) await db('projects').where({ id: project.id }).update({ private_key: null });
      continue;
    }

    const network = normalizeProjectNetwork(project.network);
    const chain = projectNetworkToWalletChain(network);
    for (let offset = 0; offset < advertisements.length; offset += 20) {
      const batch = advertisements.slice(offset, offset + 20);
      const advertiser = new WalletAdvertiser(
        chain,
        project.private_key,
        storageUrlForChain(chain),
        batch[0].domain,
      );
      await advertiser.init();
      await submit(await advertiser.revokeAdvertisements(batch));
    }
    const remaining = [
      ...await lookup(identityKey, 'SHIP'),
      ...await lookup(identityKey, 'SLAP'),
    ];
    if (remaining.length) {
      throw new Error(`Legacy identity for ${project.project_uuid} still has ${remaining.length} advertisements`);
    }
    await db('projects').where({ id: project.id }).update({ private_key: null });
  }

  logger.info({ execute, projects: projects.length, advertisements: advertisementCount }, 'Legacy advertisement migration complete');
  await db.destroy();
}

main().catch(async error => {
  logger.fatal({ error }, 'Legacy advertisement migration failed');
  await db.destroy().catch(() => undefined);
  process.exitCode = 1;
});
