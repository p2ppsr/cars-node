import { KeyDeriver, PrivateKey, PushDrop, Transaction, Utils, type LookupQuestion, type TaggedBEEF } from '@bsv/sdk';
import type { Advertisement, Engine } from '@bsv/overlay';
import { WalletAdvertiser } from '@bsv/overlay-discovery-services';
import type { Knex } from 'knex';
import logger from '../logger';
import { storageUrlForChain, type ProjectNetwork, type WalletChain } from '../network';
import { makeWallet } from '../utils/wallet';
import { PassiveAdvertiser } from './passive-advertiser';

export interface DesiredAdvertisement {
  network: ProjectNetwork;
  protocol: 'SHIP' | 'SLAP';
  domain: string;
  capability: string;
}

export interface ReconcileReport {
  desired: number;
  observed: number;
  created: number;
  revoked: number;
  skipped: boolean;
  startedAt: string;
  completedAt: string;
  error?: string;
}

function tuple(protocol: string, domain: string, capability: string): string {
  return `${protocol}\u0000${domain}\u0000${capability}`;
}

function advertisementRank(advertisement: Advertisement): [number, string, number] {
  if (advertisement.beef === undefined || advertisement.outputIndex === undefined) {
    return [-1, '', -1];
  }
  try {
    const transaction = Transaction.fromBEEF(advertisement.beef);
    return [
      transaction.merklePath?.blockHeight ?? -1,
      transaction.id('hex'),
      advertisement.outputIndex,
    ];
  } catch {
    return [-1, '', advertisement.outputIndex];
  }
}

function compareAdvertisementRank(left: Advertisement, right: Advertisement): number {
  const leftRank = advertisementRank(left);
  const rightRank = advertisementRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] === rightRank[index]) continue;
    return leftRank[index] > rightRank[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Revoke every non-desired output and all but the newest output for each
 * desired tuple. Advertisement lookup is output-oriented, so merely checking
 * a Set of observed tuples leaves retry-created duplicates live forever.
 */
export function selectAdvertisementsToRevoke(
  desired: DesiredAdvertisement[],
  observed: Advertisement[],
): Advertisement[] {
  const desiredKeys = new Set(
    desired.map(advertisement => tuple(
      advertisement.protocol,
      advertisement.domain,
      advertisement.capability,
    )),
  );
  const groups = new Map<string, Advertisement[]>();
  for (const advertisement of observed) {
    const key = tuple(
      advertisement.protocol,
      advertisement.domain,
      advertisement.topicOrService,
    );
    const group = groups.get(key) || [];
    group.push(advertisement);
    groups.set(key, group);
  }

  const revocations: Advertisement[] = [];
  for (const [key, advertisements] of groups) {
    if (!desiredKeys.has(key)) {
      revocations.push(...advertisements);
      continue;
    }
    advertisements.sort(compareAdvertisementRank);
    revocations.push(...advertisements.slice(1));
  }
  return revocations;
}

function toChain(network: ProjectNetwork): WalletChain {
  if (network === 'mainnet') return 'main';
  if (network === 'testnet') return 'test';
  return 'ttn';
}

export class AdvertisementReconciler {
  readonly identityKey: string;
  private readonly passiveAdvertiser = new PassiveAdvertiser();
  private running = false;

  constructor(
    private readonly db: Knex,
    private readonly engine: Engine,
    private readonly privateKey: string,
    private readonly network: ProjectNetwork,
  ) {
    this.identityKey = new KeyDeriver(new PrivateKey(privateKey, 'hex')).identityKey;
  }

  async desiredAdvertisements(): Promise<DesiredAdvertisement[]> {
    const rows = await this.db('cars_advertised_capabilities')
      .select('network', 'protocol', 'domain', 'capability')
      .where({ active: true, network: this.network })
      .orderBy(['domain', 'protocol', 'capability']);
    const unique = new Map<string, DesiredAdvertisement>();
    for (const row of rows as DesiredAdvertisement[]) {
      unique.set(tuple(row.protocol, row.domain, row.capability), row);
    }
    return [...unique.values()];
  }

  async observedAdvertisements(): Promise<Advertisement[]> {
    const advertisements: Advertisement[] = [];
    for (const protocol of ['SHIP', 'SLAP'] as const) {
      const service = protocol === 'SHIP' ? 'ls_ship' : 'ls_slap';
      const query: LookupQuestion = {
        service,
        query: { identityKey: this.identityKey, limit: 10_000 },
      };
      const answer = await this.engine.lookup(query);
      if (answer.type !== 'output-list') continue;
      for (const output of answer.outputs) {
        try {
          const tx = Transaction.fromBEEF(output.beef);
          const advertisement = this.passiveAdvertiser.parseAdvertisement(
            tx.outputs[output.outputIndex].lockingScript,
          );
          if (advertisement.protocol === protocol && advertisement.identityKey === this.identityKey) {
            advertisements.push({ ...advertisement, beef: output.beef, outputIndex: output.outputIndex });
          }
        } catch (error) {
          logger.warn({ error, protocol }, 'Ignoring an unreadable advertisement during reconciliation');
        }
      }
    }
    return advertisements;
  }

  async reconcile(): Promise<ReconcileReport> {
    const startedAt = new Date().toISOString();
    if (this.running) {
      return {
        desired: 0,
        observed: 0,
        created: 0,
        revoked: 0,
        skipped: true,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
    this.running = true;
    let desiredCount = 0;
    let observedCount = 0;
    let created = 0;
    let revoked = 0;
    try {
      const desired = await this.desiredAdvertisements();
      let observed = await this.observedAdvertisements();
      desiredCount = desired.length;
      observedCount = observed.length;
      const observedKeys = new Set(observed.map(ad => tuple(ad.protocol, ad.domain, ad.topicOrService)));
      const missing = desired.filter(ad => !observedKeys.has(tuple(ad.protocol, ad.domain, ad.capability)));

      // Create first. A transient failure can leave duplicates during migration,
      // but it cannot remove the fleet's last valid advertisement.
      if (missing.length > 0) {
        const taggedBEEF = await this.createFleetAdvertisements(missing);
        await this.submitAndRecord('create', missing, taggedBEEF);
        created = missing.length;
      }

      // Re-read from authoritative local discovery state before calculating
      // revocations. This makes retry after an ambiguous submit idempotent.
      observed = await this.observedAdvertisements();
      const staleOrDuplicate = selectAdvertisementsToRevoke(desired, observed);
      const revocationsByDomain = new Map<string, Advertisement[]>();
      for (const advertisement of staleOrDuplicate) {
        const batch = revocationsByDomain.get(advertisement.domain) || [];
        batch.push(advertisement);
        revocationsByDomain.set(advertisement.domain, batch);
      }
      for (const [domain, advertisements] of revocationsByDomain) {
        for (let offset = 0; offset < advertisements.length; offset += 20) {
          const batch = advertisements.slice(offset, offset + 20);
          const advertiser = await this.advertiserForDomain(domain);
          const taggedBEEF = await advertiser.revokeAdvertisements(batch);
          await this.submitAndRecord('revoke', batch.map(ad => ({
            network: this.network,
            protocol: ad.protocol,
            domain: ad.domain,
            capability: ad.topicOrService,
          })), taggedBEEF);
          revoked += batch.length;
        }
      }

      return {
        desired: desiredCount,
        observed: observedCount,
        created,
        revoked,
        skipped: false,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (error: any) {
      logger.error({ error }, 'CARS advertisement reconciliation failed');
      return {
        desired: desiredCount,
        observed: observedCount,
        created,
        revoked,
        skipped: false,
        startedAt,
        completedAt: new Date().toISOString(),
        error: error?.message || String(error),
      };
    } finally {
      this.running = false;
    }
  }

  private async advertiserForDomain(domain: string): Promise<WalletAdvertiser> {
    const instance = new WalletAdvertiser(
      toChain(this.network),
      this.privateKey,
      storageUrlForChain(toChain(this.network)),
      domain,
    );
    await instance.init();
    return instance;
  }

  /**
   * WalletAdvertiser binds one domain per instance. CARS needs one transaction
   * spanning many backend domains, so build each output with its domain-bound
   * advertiser and combine all outputs into one node-wallet createAction.
   */
  private async createFleetAdvertisements(advertisements: DesiredAdvertisement[]): Promise<TaggedBEEF> {
    const wallet = await makeWallet(toChain(this.network), this.privateKey);
    const pushDrop = new PushDrop(wallet);
    const outputs = await Promise.all(advertisements.map(async advertisement => ({
      lockingScript: (await pushDrop.lock([
        Utils.toArray(advertisement.protocol, 'utf8'),
        Utils.toArray(this.identityKey, 'hex'),
        Utils.toArray(advertisement.domain, 'utf8'),
        Utils.toArray(advertisement.capability, 'utf8'),
      ], [2, advertisement.protocol === 'SHIP' ? 'service host interconnect' : 'service lookup availability'], '1', 'anyone', true)).toHex(),
      satoshis: 1,
      outputDescription: `${advertisement.protocol} advertisement of ${advertisement.capability}`,
    })));
    const action = await wallet.createAction({
      outputs,
      description: 'CARS fleet SHIP/SLAP advertisement issuance',
      options: {
        // The storage provider already knows every node-wallet ancestor. A
        // txid-only parent is sufficient and prevents an unrelated long-lived
        // funding chain from bloating this fleet advertisement BEEF.
        trustSelf: 'known',
      },
    });
    if (!action.tx) throw new Error('Fleet advertisement createAction did not return a transaction');
    const transaction = Transaction.fromAtomicBEEF(action.tx);
    return {
      beef: transaction.toBEEF(),
      topics: [...new Set(advertisements.map(ad => ad.protocol === 'SHIP' ? 'tm_ship' : 'tm_slap'))],
    };
  }

  private async submitAndRecord(
    action: 'create' | 'revoke',
    advertisements: DesiredAdvertisement[],
    taggedBEEF: TaggedBEEF,
  ): Promise<void> {
    const txid = Transaction.fromBEEF(taggedBEEF.beef).id('hex');
    const ids: number[] = [];
    for (const ad of advertisements) {
      const [id] = await this.db('cars_advertisement_operations').insert({
        action,
        network: ad.network,
        identity_key: this.identityKey,
        protocol: ad.protocol,
        domain: ad.domain,
        capability: ad.capability,
        txid,
        status: 'pending',
      });
      ids.push(Number(id));
    }
    try {
      await this.engine.submit(taggedBEEF);
      await this.db('cars_advertisement_operations').whereIn('id', ids).update({
        status: 'succeeded',
        updated_at: this.db.fn.now(),
      });
    } catch (error: any) {
      await this.db('cars_advertisement_operations').whereIn('id', ids).update({
        status: 'failed',
        error: String(error?.message || error).slice(0, 60_000),
        updated_at: this.db.fn.now(),
      });
      throw error;
    }
  }
}
