import { KeyDeriver, PrivateKey, Transaction, type LookupQuestion, type TaggedBEEF } from '@bsv/sdk';
import type { Advertisement, Engine } from '@bsv/overlay';
import { WalletAdvertiser } from '@bsv/overlay-discovery-services';
import type { Knex } from 'knex';
import logger from '../logger';
import { storageUrlForChain, type ProjectNetwork, type WalletChain } from '../network';
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

function toChain(network: ProjectNetwork): WalletChain {
  if (network === 'mainnet') return 'main';
  if (network === 'testnet') return 'test';
  return 'ttn';
}

export class AdvertisementReconciler {
  readonly identityKey: string;
  private readonly passiveAdvertiser = new PassiveAdvertiser();
  private readonly advertisers = new Map<string, Promise<WalletAdvertiser>>();
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
    return rows as DesiredAdvertisement[];
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
      const byDomain = new Map<string, DesiredAdvertisement[]>();
      for (const ad of missing) {
        const group = byDomain.get(ad.domain) || [];
        group.push(ad);
        byDomain.set(ad.domain, group);
      }
      for (const [domain, advertisements] of byDomain) {
        const advertiser = await this.advertiserForDomain(domain);
        const taggedBEEF = await advertiser.createAdvertisements(advertisements.map(ad => ({
          protocol: ad.protocol,
          topicOrServiceName: ad.capability,
        })));
        await this.submitAndRecord('create', advertisements, taggedBEEF);
        created += advertisements.length;
      }

      // Re-read from authoritative local discovery state before calculating
      // revocations. This makes retry after an ambiguous submit idempotent.
      observed = await this.observedAdvertisements();
      const desiredKeys = new Set(desired.map(ad => tuple(ad.protocol, ad.domain, ad.capability)));
      const stale = observed.filter(ad => !desiredKeys.has(tuple(ad.protocol, ad.domain, ad.topicOrService)));
      for (let offset = 0; offset < stale.length; offset += 20) {
        const batch = stale.slice(offset, offset + 20);
        const advertiser = await this.advertiserForDomain(batch[0].domain);
        const taggedBEEF = await advertiser.revokeAdvertisements(batch);
        await this.submitAndRecord('revoke', batch.map(ad => ({
          network: this.network,
          protocol: ad.protocol,
          domain: ad.domain,
          capability: ad.topicOrService,
        })), taggedBEEF);
        revoked += batch.length;
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

  private advertiserForDomain(domain: string): Promise<WalletAdvertiser> {
    let advertiser = this.advertisers.get(domain);
    if (!advertiser) {
      advertiser = (async () => {
        const instance = new WalletAdvertiser(
          toChain(this.network),
          this.privateKey,
          storageUrlForChain(toChain(this.network)),
          domain,
        );
        await instance.init();
        return instance;
      })();
      this.advertisers.set(domain, advertiser);
    }
    return advertiser;
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
