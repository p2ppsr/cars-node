import axios from 'axios';
import { KeyDeriver, LookupResolver, PrivateKey, Transaction, type TaggedBEEF } from '@bsv/sdk';
import type { Advertisement } from '@bsv/overlay';
import { WalletAdvertiser } from '@bsv/overlay-discovery-services';
import { Services } from '@bsv/wallet-toolbox-client';
import db from '../db';
import logger from '../logger';
import { normalizeProjectNetwork, projectNetworkToWalletChain, storageUrlForChain } from '../network';
import { PassiveAdvertiser } from '../advertisements/passive-advertiser';
import { findBalanceForKey, fundKey, makeWallet } from '../utils/wallet';

const controllerUrl = process.env.ADVERTISEMENT_CONTROLLER_URL ||
  'http://cars-advertisement-controller.cars-operator-system.svc.cluster.local:8081';
const parser = new PassiveAdvertiser();
const REVOCATION_BALANCE = 500;
const fundingWallets = new Map<string, ReturnType<typeof makeWallet>>();
const chainServices = new Map<string, Services>();

async function ensureRevocationBalance(
  privateKey: string,
  network: ReturnType<typeof normalizeProjectNetwork>,
): Promise<number> {
  const balance = await findBalanceForKey(privateKey, network);
  if (balance >= REVOCATION_BALANCE) return 0;
  const chain = projectNetworkToWalletChain(network);
  const sourceKey = network === 'mainnet'
    ? process.env.CARS_ADVERTISEMENT_PRIVATE_KEY
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

async function onlyUnspent(
  advertisements: Advertisement[],
  network: ReturnType<typeof normalizeProjectNetwork>,
): Promise<Advertisement[]> {
  const chain = projectNetworkToWalletChain(network);
  let services = chainServices.get(network);
  if (!services) {
    services = new Services(chain);
    chainServices.set(network, services);
  }
  const unspent: Advertisement[] = [];
  const seen = new Set<string>();
  for (const advertisement of advertisements) {
    if (advertisement.beef === undefined || advertisement.outputIndex === undefined) {
      throw new Error('Public advertisement is missing its outpoint data');
    }
    const tx = Transaction.fromBEEF(advertisement.beef);
    const outpoint = `${tx.id('hex')}.${advertisement.outputIndex}`;
    if (seen.has(outpoint)) continue;
    seen.add(outpoint);
    const output = tx.outputs[advertisement.outputIndex];
    const status = await services.getUtxoStatus(
      output.lockingScript.toHex(),
      'script',
      outpoint,
    );
    if (status.status !== 'success' || typeof status.isUtxo !== 'boolean') {
      throw new Error(`Could not conclusively determine UTXO status for ${outpoint}`);
    }
    if (status.isUtxo) unspent.push(advertisement);
  }
  return unspent;
}

async function verifyPublicAbsence(
  identityKey: string,
  network: ReturnType<typeof normalizeProjectNetwork>,
): Promise<void> {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const remaining = await onlyUnspent(await lookupPublic(identityKey, network), network);
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
  const submitOnly = process.argv.includes('--submit-only');
  const finalizeOnly = process.argv.includes('--finalize-only');
  if (submitOnly && finalizeOnly) throw new Error('--submit-only and --finalize-only are mutually exclusive');
  const execute = process.argv.includes('--execute') || submitOnly || finalizeOnly;
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
    const discovered = await lookupPublic(identityKey, network);
    const advertisements = await onlyUnspent(discovered, network);
    advertisementCount += advertisements.length;
    logger.info({
      projectId: project.project_uuid,
      advertisements: advertisements.length,
      staleAdvertisements: discovered.length - advertisements.length,
    }, execute ? 'Revoking legacy advertisements' : 'Legacy advertisement revoke preview');
    if (!execute || advertisements.length === 0) {
      if (execute) await db('projects').where({ id: project.id }).update({ private_key: null });
      continue;
    }
    if (finalizeOnly) {
      logger.info({ projectId: project.project_uuid, advertisements: advertisements.length },
        'Legacy advertisements are still awaiting retirement confirmation');
      continue;
    }

    const chain = projectNetworkToWalletChain(network);
    const projectWallet = await makeWallet(chain, project.private_key);
    const actions = await projectWallet.listActions({ labels: [], limit: 10_000 });
    const pendingRevocations = actions.actions.filter(action =>
      action.description === 'Revoke SHIP/SLAP advertisements' &&
      (action.status === 'unproven' || action.status === 'sending'));
    if (pendingRevocations.length) {
      logger.info({ projectId: project.project_uuid, pendingRevocations: pendingRevocations.length },
        'Retaining legacy key while revocation transactions await confirmation');
      continue;
    }
    const advertisementBatches = new Map<string, Advertisement[]>();
    for (const advertisement of advertisements) {
      const batchKey = `${advertisement.protocol}\u0000${advertisement.domain}`;
      const batch = advertisementBatches.get(batchKey) || [];
      batch.push(advertisement);
      advertisementBatches.set(batchKey, batch);
    }
    // Submit at most one batch for an identity per pass. A signed revocation
    // immediately becomes an unproven wallet action and may consume the
    // wallet's only usable change output. Trying to construct the next
    // protocol/domain batch before that action is proven can fail with
    // WERR_INVALID_OPERATION. The next pass resumes after confirmation.
    const protocolAdvertisements = advertisementBatches.values().next().value as Advertisement[] | undefined;
    if (!protocolAdvertisements?.length) continue;
    const batch = protocolAdvertisements.slice(0, 20);
    const funded = await ensureRevocationBalance(project.private_key, network);
    if (funded) {
      logger.info({ projectId: project.project_uuid, network, funded },
        'Funded legacy advertisement revocation batch');
    }
    const advertiser = new WalletAdvertiser(
      chain,
      project.private_key,
      storageUrlForChain(chain),
      batch[0].domain,
    );
    await advertiser.init();
    await submit(await advertiser.revokeAdvertisements(batch));
    if (submitOnly) {
      logger.info({ projectId: project.project_uuid, advertisements: advertisements.length },
        'Submitted legacy advertisements for retirement; retaining key until finalization');
      continue;
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
