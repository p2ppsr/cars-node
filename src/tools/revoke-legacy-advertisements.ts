import axios from 'axios';
import { KeyDeriver, LookupResolver, PrivateKey, Transaction, type TaggedBEEF } from '@bsv/sdk';
import type { Advertisement } from '@bsv/overlay';
import { WalletAdvertiser } from '@bsv/overlay-discovery-services';
import db from '../db';
import logger from '../logger';
import { normalizeProjectNetwork, projectNetworkToWalletChain, storageUrlForChain } from '../network';
import { PassiveAdvertiser } from '../advertisements/passive-advertiser';
import { findBalanceForKey, fundKey, makeWallet } from '../utils/wallet';

const controllerUrl = process.env.ADVERTISEMENT_CONTROLLER_URL ||
  'http://cars-advertisement-controller.cars-operator-system.svc.cluster.local:8081';
const parser = new PassiveAdvertiser();
const REVOCATION_BALANCE = 2_000;
const fundingWallets = new Map<string, ReturnType<typeof makeWallet>>();

async function ensureRevocationBalance(
  privateKey: string,
  network: ReturnType<typeof normalizeProjectNetwork>,
): Promise<number> {
  const balance = await findBalanceForKey(privateKey, network);
  if (balance >= REVOCATION_BALANCE) return 0;
  const chain = projectNetworkToWalletChain(network);
  const sourceKey = network === 'mainnet'
    ? process.env.MAINNET_PRIVATE_KEY
    : network === 'testnet'
      ? process.env.TESTNET_PRIVATE_KEY
      : process.env.TTN_PRIVATE_KEY;
  if (!sourceKey) throw new Error(`No CARS funding wallet is configured for ${network}`);
  let sourceWallet = fundingWallets.get(network);
  if (!sourceWallet) {
    sourceWallet = makeWallet(chain, sourceKey);
    fundingWallets.set(network, sourceWallet);
  }
  const amount = REVOCATION_BALANCE - balance;
  await fundKey(await sourceWallet, privateKey, amount, network);
  return amount;
}

async function lookupController(identityKey: string, protocol: 'SHIP' | 'SLAP'): Promise<Advertisement[]> {
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

async function lookupPublic(
  identityKey: string,
  network: ReturnType<typeof normalizeProjectNetwork>,
): Promise<Advertisement[]> {
  const chain = projectNetworkToWalletChain(network);
  const networkPreset = chain === 'test' ? 'testnet' : chain === 'ttn' ? 'teratestnet' : 'mainnet';
  const resolver = new LookupResolver({ networkPreset });
  const advertisements: Advertisement[] = [];
  for (const protocol of ['SHIP', 'SLAP'] as const) {
    // Call LookupResolver directly because WalletAdvertiser intentionally
    // converts tracker failures into empty results. Key retirement must fail
    // closed when either public discovery query is unavailable.
    const answer = await resolver.query({
      service: protocol === 'SHIP' ? 'ls_ship' : 'ls_slap',
      query: { identityKey },
    });
    if (answer.type !== 'output-list') {
      throw new Error(`Unexpected ${protocol} lookup response type: ${answer.type}`);
    }
    for (const output of answer.outputs) {
      const beef = output.beef;
      const tx = Transaction.fromBEEF(beef);
      const advertisement = parser.parseAdvertisement(tx.outputs[output.outputIndex].lockingScript);
      if (advertisement.protocol !== protocol || advertisement.identityKey !== identityKey) {
        throw new Error(`Public ${protocol} lookup returned an advertisement for a different identity`);
      }
      advertisements.push({ ...advertisement, beef, outputIndex: output.outputIndex });
    }
  }
  return advertisements;
}

async function verifyPublicAbsence(
  identityKey: string,
  network: ReturnType<typeof normalizeProjectNetwork>,
): Promise<void> {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const remaining = await lookupPublic(identityKey, network);
    if (remaining.length === 0) return;
    if (attempt === 12) {
      throw new Error(`Legacy identity still has ${remaining.length} public advertisements`);
    }
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }
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
    ...await lookupController(nodeIdentityKey, 'SHIP'),
    ...await lookupController(nodeIdentityKey, 'SLAP'),
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
    if (identityKey === nodeIdentityKey) {
      throw new Error(`Refusing legacy revocation: project ${project.project_uuid} uses the controller identity`);
    }
    const network = normalizeProjectNetwork(project.network);
    const advertisements = await lookupPublic(identityKey, network);
    advertisementCount += advertisements.length;
    logger.info({ projectId: project.project_uuid, advertisements: advertisements.length }, execute ? 'Revoking legacy advertisements' : 'Legacy advertisement revoke preview');
    if (!execute || advertisements.length === 0) {
      if (execute) await db('projects').where({ id: project.id }).update({ private_key: null });
      continue;
    }

    const chain = projectNetworkToWalletChain(network);
    const funded = await ensureRevocationBalance(project.private_key, network);
    if (funded) {
      logger.info({ projectId: project.project_uuid, network, funded }, 'Funded legacy advertisement revocation');
    }
    const advertisementsByDomain = new Map<string, Advertisement[]>();
    for (const advertisement of advertisements) {
      const domainAdvertisements = advertisementsByDomain.get(advertisement.domain) || [];
      domainAdvertisements.push(advertisement);
      advertisementsByDomain.set(advertisement.domain, domainAdvertisements);
    }
    for (const [domain, domainAdvertisements] of advertisementsByDomain) {
      for (let offset = 0; offset < domainAdvertisements.length; offset += 20) {
        const batch = domainAdvertisements.slice(offset, offset + 20);
        const advertiser = new WalletAdvertiser(
          chain,
          project.private_key,
          storageUrlForChain(chain),
          domain,
        );
        await advertiser.init();
        await submit(await advertiser.revokeAdvertisements(batch));
      }
    }
    await verifyPublicAbsence(identityKey, network);
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
