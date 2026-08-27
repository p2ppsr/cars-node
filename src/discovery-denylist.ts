import { Engine } from '@bsv/overlay';
import { SHIPStorage, SLAPStorage } from '@bsv/overlay-discovery-services';
import { PushDrop, Transaction, Utils } from '@bsv/sdk';
import logger from './logger';

export const DEFAULT_DISCOVERY_DENYLIST = [
  'https://anvil.sendbsv.com',
  'https://pursuant-nature-bloomers.ngrok-free.dev',
  'https://backend.392b8a0eaa02fe10aaa08adf02f3f937.projects.metanet.club',
  'https://backend.91994de0c8be517a4041e178b2f8c338.projects.metanet.club',
  'https://backend.118f28473d8b178101569f451204adb3.projects.metanet.club',
  'https://backend.463a5e81e29fe79f94d3381b7a42d6be.projects.metanet.club',
  // 2026-08-26 authoritative inventory audit: every host below served none
  // of its claimed SHIP/SLAP capabilities in all three independent rounds.
  'https://002c202a64d2.ngrok-free.app',
  'https://1112787c5be4.ngrok-free.app',
  'https://153e77a2d4ea.ngrok-free.app',
  'https://3789e8f494a7.ngrok-free.app',
  'https://415f51b378dd.ngrok-free.app',
  'https://47ea25a819e1.ngrok-free.app',
  'https://4d9268666e6d.ngrok-free.app',
  'https://5238e629e428.ngrok-free.app',
  'https://75f39d0a2ecd.ngrok-free.app',
  'https://79412930095b.ngrok-free.app',
  'https://80734d2c28ee.ngrok-free.app',
  'https://84a0ec5f8346.ngrok-free.app',
  'https://b184-74-51-29-58.ngrok-free.app',
  'https://b45a0169b2ad.ngrok-free.app',
  'https://b6694c3a18c5.ngrok-free.app',
  'https://backend.05218c90a7d8e37717db9fea360d99dd.projects.metanet.club',
  'https://backend.0e8cd9bf830ff26fa4d7daa5610047e3.projects.babbage.systems',
  'https://backend.0f34a1393d05dfd0852c44ebb2ab532d.projects.metanet.club',
  'https://backend.13906f5f3591ef53286ea5ca6539f3f5.projects.babbage.systems',
  'https://backend.15cee93527953baca497a6ea3413f33c.projects.metanet.club',
  'https://backend.1bb23b535b4f07877a9f5d02916d9cd4.projects.babbage.systems',
  'https://backend.242faf58cc5e419d28aeef6045287105.projects.metanet.club',
  'https://backend.2b51fd0cfb9b1c97949be827ad8a921c.projects.babbage.systems',
  'https://backend.2e97d492e90354a3a453e526cf53819c.projects.babbage.systems',
  'https://backend.2f1a64dd7f952437e06a5053ccc5a9e4.projects.babbage.systems',
  'https://backend.328131a2aa9e313124a20918fe54d7c3.projects.metanet.club',
  'https://backend.379d53c918b867e304c60ed581d2298d.projects.babbage.systems',
  'https://backend.3b90910bf42e77f351ab6d93f6ef26b2.projects.brc100.app',
  'https://backend.3ba03bd20ec0fae6602b1574c1446678.apps.beta.calhouncars.com',
  'https://backend.40406d9ea258f56b1f358c1dacb53921.projects.brc100.app',
  'https://backend.410747456229f0b014e74af4f0af4378.projects.metanet.club',
  'https://backend.44c8030f1f7c8af2dc7501c7df7cb179.projects.metanet.club',
  'https://backend.46a5f172214d9e97dbf26472cea50217.projects.babbage.systems',
  'https://backend.4f55b09c3c607cac81e549b02065e35c.projects.metanet.club',
  'https://backend.60806ee44b53f3e7418eb3f66c44ea3a.projects.brc100.app',
  'https://backend.6b24de9fbf4f8595f79dbdeeadca18e6.projects.metanet.club',
  'https://backend.6f438009ad296237dc07bca8c452a345.projects.babbage.systems',
  'https://backend.7297accc007eea48e2b1149f1238458c.projects.metanet.club',
  'https://backend.7523e54bb7f496e72f77ad78c7a2324a.projects.metanet.club',
  'https://backend.7531b5a70d9bcd4a044418f96a67dbed.projects.metanet.club',
  'https://backend.8161440dd708aee41e9adeac2c1bea44.projects.babbage.systems',
  'https://backend.81ff35b8c685c32feec42de63e8573bd.projects.babbage.systems',
  'https://backend.8241b038f149770ffafe45b2c67d000b.projects.metanet.club',
  'https://backend.841c25be1e7c197d1a502676725ea2d2.cars.metanet.club',
  'https://backend.8aa5d352f2faaa97700a4dfa89e30ab0.apps.alpha.calhouncars.com',
  'https://backend.8f954be9fdfb172013896936f3100f30.projects.b1nary.cloud',
  'https://backend.91059bf8c0beecb8fdb5962a1fd94c5c.projects.babbage.systems',
  'https://backend.955b036f28ada692a4d0fb8e5bc1f782.projects.babbage.systems',
  'https://backend.9802e2f8af477a5842785fed9bc1bbea.projects.babbage.systems',
  'https://backend.9a423bf52a31a528bcddf45a73abcb03.projects.metanet.club',
  'https://backend.9c1c54a17d0a75465c57965009462d44.projects.metanet.club',
  'https://backend.9d3648a6cfecfc9d2653d7f506b719a6.projects.metanet.club',
  'https://backend.9e0d7d31c278a4baf1201e59cea4d539.projects.babbage.systems',
  'https://backend.a6b7bb500651935a164fe28292dbb891.projects.metanet.club',
  'https://backend.abcfd5ba7a90aa04aecfb50d216e8ccb.projects.babbage.systems',
  'https://backend.abf8157b263b15ed46dbc4731aabc508.projects.metanet.club',
  'https://backend.b08dcd731e5c59e20b2906aa2472d849.projects.babbage.systems',
  'https://backend.b0b6edfd50af788a135bee963d90acef.projects.metanet.club',
  'https://backend.c9bfd69c73720d00d0a555a897f7d971.projects.metanet.club',
  'https://backend.d1284e4754ecc324c3133d07a797828b.projects.babbage.systems',
  'https://backend.d3efbea60c05ebca341ce638900c5202.cars.metanet.club',
  'https://backend.d612c70a9edc1bfb362c64830e88fd7b.projects.babbage.systems',
  'https://backend.d7ea44c2d2af8f5db0113e11c52db3e7.projects.brc100.app',
  'https://backend.dac2e0677a090558614ac1fe2a9f65d1.projects.babbage.systems',
  'https://backend.e25664b39e5d4636b75599abb6079949.projects.babbage.systems',
  'https://backend.e276a4cb0863c79c77dc58f098e5f55e.projects.metanet.club',
  'https://backend.e42e1a64b1fee160b88e02160d70feec.projects.babbage.systems',
  'https://backend.e6e722c7ec7fe6e63bb583d4b184eb80.projects.b1nary.cloud',
  'https://backend.e7acb3c2bb3c958f7a29710e5cb67134.projects.babbage.systems',
  'https://backend.ea98977f72defcf56238a39a35af6875.projects.babbage.systems',
  'https://backend.ec9f039909499efb4a3ad6d7083365c1.projects.babbage.systems',
  'https://backend.f1b247ccc4f9c78453ae0d46583cf126.projects.babbage.systems',
  'https://backend.f496672ea43f73e5c158ef19097f4356.projects.b1nary.cloud',
  'https://backend.f5a90f978ce05754c834f873fa8f8fe5.projects.babbage.systems',
  'https://backend.f814347ab6bf690f53148d3277ac5c18.projects.babbage.systems',
  'https://backend.fb057842923ccc5bc6a4a22018b9805c.projects.babbage.systems',
  'https://backend.fd0445ada403f547971d9728f121cab6.projects.metanet.club',
  'https://cecddd371ae1.ngrok-free.app',
  'https://chooser-crimp-recast.ngrok-free.dev',
  'https://composer-overlay.dev-a3e.workers.dev',
  'https://df65f8f4fc74.ngrok-free.app',
  'https://ea99f04c3711.ngrok-free.app',
  'https://f0423b0360e8.ngrok-free.app',
  'https://f421388589de.ngrok-free.app',
  'https://f59d3e387976.ngrok-free.app',
  'https://low-overlay.dev-a3e.workers.dev',
  'https://type-stamp-overlay-2-production.up.railway.app',
  'https://type-stamp-overlay-production.up.railway.app',
] as const;

export type DiscoveryAdvertisementProtocol = 'SHIP' | 'SLAP';

export interface DiscoveryCapabilityDenyRule {
  protocol: DiscoveryAdvertisementProtocol;
  domain: string;
  capability: string;
}

// These active CARS projects still serve their application capabilities, but
// no longer serve discovery itself. Deny only their obsolete discovery claims.
const THIN_CARS_DISCOVERY_DOMAINS = [
  'https://backend.161a4f0f091010a0f8a34a5d1d1b9dd7.projects.babbage.systems',
  'https://backend.2efa4b8fe4c2bd42083636871b007e9e.projects.babbage.systems',
  'https://backend.50247d539b678476a0b00db7bd5584e8.projects.babbage.systems',
  'https://backend.59d6f2d7e6314d0b188e11df0f516478.projects.babbage.systems',
  'https://backend.6a33ab530105ffdc39886db56229fa45.projects.babbage.systems',
  'https://backend.c7350da1b9bf4738a4fa7646eef8285f.projects.babbage.systems',
  'https://backend.e3703603a3fe9f2dde54a73a7d7f1612.projects.babbage.systems',
  'https://backend.e40be69a5b6200a8f2b23758f2174093.projects.babbage.systems',
  'https://backend.f8ad4f88d28eff5fd4ab1411e2520a31.projects.babbage.systems',
] as const;

export const DEFAULT_DISCOVERY_CAPABILITY_DENYLIST: readonly DiscoveryCapabilityDenyRule[] =
  THIN_CARS_DISCOVERY_DOMAINS.flatMap(domain => [
    { protocol: 'SHIP', domain, capability: 'tm_ship' },
    { protocol: 'SHIP', domain, capability: 'tm_slap' },
    { protocol: 'SLAP', domain, capability: 'ls_ship' },
    { protocol: 'SLAP', domain, capability: 'ls_slap' },
  ] as const);

export function normalizeDiscoveryDomain(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

export function discoveryDenylist(value = process.env.CARS_BANNED_AD_DOMAINS): Set<string> {
  const configured = value === undefined ? DEFAULT_DISCOVERY_DENYLIST.join(',') : value;
  return new Set(configured.split(',').map(normalizeDiscoveryDomain).filter(Boolean));
}

export function discoveryCapabilityKey(
  protocol: DiscoveryAdvertisementProtocol,
  domain: string,
  capability: string,
): string {
  return `${protocol}|${normalizeDiscoveryDomain(domain)}|${String(capability || '').trim()}`;
}

export function serializeDiscoveryCapabilityDenylist(
  rules: readonly DiscoveryCapabilityDenyRule[] = DEFAULT_DISCOVERY_CAPABILITY_DENYLIST,
): string {
  return rules.map(rule => discoveryCapabilityKey(
    rule.protocol,
    rule.domain,
    rule.capability,
  )).join(',');
}

export function discoveryCapabilityDenylist(
  value = process.env.CARS_BANNED_AD_CAPABILITIES,
): Set<string> {
  const configured = value === undefined ? serializeDiscoveryCapabilityDenylist() : value;
  const denied = new Set<string>();
  for (const entry of configured.split(',')) {
    const [protocol, domain, ...capabilityParts] = entry.split('|');
    const capability = capabilityParts.join('|').trim();
    if ((protocol !== 'SHIP' && protocol !== 'SLAP') || !domain || !capability) continue;
    denied.add(discoveryCapabilityKey(protocol, domain, capability));
  }
  return denied;
}

export function isDiscoveryCapabilityDenied(
  deniedDomains: ReadonlySet<string>,
  deniedCapabilities: ReadonlySet<string>,
  protocol: DiscoveryAdvertisementProtocol,
  domain: string,
  capability: string,
): boolean {
  const normalizedDomain = normalizeDiscoveryDomain(domain);
  return deniedDomains.has(normalizedDomain) || deniedCapabilities.has(
    discoveryCapabilityKey(protocol, normalizedDomain, capability),
  );
}

/**
 * Overlay discovery treats valid unspent advertisements as synchronizable.
 * A local operator denylist therefore has to guard both Engine retention and
 * Mongo discovery insertion or GASP can restore an evicted record.
 */
export function installDiscoveryDenylist(
  value = process.env.CARS_BANNED_AD_DOMAINS,
  preferredIdentityKey?: string,
  capabilityValue = process.env.CARS_BANNED_AD_CAPABILITIES,
): Set<string> {
  const deniedDomains = discoveryDenylist(value);
  const deniedCapabilities = discoveryCapabilityDenylist(capabilityValue);
  if (deniedDomains.size === 0 && deniedCapabilities.size === 0) return deniedDomains;

  const EnginePrototype = Engine.prototype as any;
  if (!EnginePrototype.__carsDiscoveryDenylistPatched) {
    const originalSubmit = EnginePrototype.submit;
    EnginePrototype.__carsDiscoveryDenylistPatched = true;
    EnginePrototype.submit = async function carsDiscoveryDenylistSubmit(taggedBEEF: any, ...rest: any[]) {
      try {
        if (taggedBEEF && Array.isArray(taggedBEEF.beef) && Array.isArray(taggedBEEF.topics)) {
          const transaction = Transaction.fromBEEF(taggedBEEF.beef);
          const blockedTopics = new Set<string>();
          for (const output of transaction.outputs) {
            try {
              const decoded = PushDrop.decode(output.lockingScript);
              if (decoded.fields.length < 4) continue;
              const protocol = Utils.toUTF8(decoded.fields[0]);
              if (protocol !== 'SHIP' && protocol !== 'SLAP') continue;
              const domain = normalizeDiscoveryDomain(Utils.toUTF8(decoded.fields[2]));
              const capability = Utils.toUTF8(decoded.fields[3]);
              if (isDiscoveryCapabilityDenied(
                deniedDomains,
                deniedCapabilities,
                protocol,
                domain,
                capability,
              )) {
                blockedTopics.add(protocol === 'SHIP' ? 'tm_ship' : 'tm_slap');
              }
            } catch {
              // Normal topic managers retain responsibility for non-ad outputs.
            }
          }
          if (blockedTopics.size > 0) {
            const originalTopics = taggedBEEF.topics.map(String);
            const filteredTopics = originalTopics.filter((topic: string) => !blockedTopics.has(topic));
            logger.info({
              txid: transaction.id('hex'),
              blockedTopics: [...blockedTopics].sort(),
              filteredTopics,
            }, 'Rejected denied SHIP/SLAP advertisement topics');
            if (filteredTopics.length === 0) {
              const steak: Record<string, any> = {};
              for (const topic of originalTopics) {
                if (blockedTopics.has(topic)) {
                  steak[topic] = { outputsToAdmit: [], coinsToRetain: [], coinsRemoved: [] };
                }
              }
              return steak;
            }
            taggedBEEF = { ...taggedBEEF, topics: filteredTopics };
          }
        }
      } catch (error) {
        logger.warn({ error }, 'Could not inspect SHIP/SLAP submission against the denylist');
      }
      return originalSubmit.call(this, taggedBEEF, ...rest);
    };
  }

  const patchStorage = (
    StorageClass: any,
    methodName: 'storeSHIPRecord' | 'storeSLAPRecord',
    protocol: 'SHIP' | 'SLAP',
  ) => {
    const prototype = StorageClass?.prototype;
    const marker = `__carsDiscovery${protocol}StoragePatched`;
    if (!prototype || prototype[marker] || typeof prototype[methodName] !== 'function') return;
    const originalStore = prototype[methodName];
    prototype[marker] = true;
    prototype[methodName] = async function carsDiscoveryDenylistStore(
      txid: string,
      outputIndex: number,
      identityKey: string,
      domain: string,
      advertisedName: string,
    ) {
      const normalizedDomain = normalizeDiscoveryDomain(domain);
      if (isDiscoveryCapabilityDenied(
        deniedDomains,
        deniedCapabilities,
        protocol,
        normalizedDomain,
        advertisedName,
      )) {
        logger.info({ protocol, txid, outputIndex, domain: normalizedDomain, advertisedName },
          'Rejected denied SHIP/SLAP discovery record');
        return;
      }
      const collection = protocol === 'SHIP' ? this.shipRecords : this.slapRecords;
      const capabilityField = protocol === 'SHIP' ? 'topic' : 'service';
      if (preferredIdentityKey && collection) {
        const capabilityFilter = { domain, [capabilityField]: advertisedName };
        if (identityKey === preferredIdentityKey) {
          await collection.deleteMany({
            ...capabilityFilter,
            identityKey: { $ne: preferredIdentityKey },
          });
        } else if (await collection.findOne({
          ...capabilityFilter,
          identityKey: preferredIdentityKey,
        })) {
          logger.info({ protocol, txid, outputIndex, domain: normalizedDomain, advertisedName },
            'Rejected duplicate discovery record superseded by the controller identity');
          return;
        } else {
          await collection.deleteMany({
            ...capabilityFilter,
            identityKey: { $ne: identityKey },
          });
        }
      }
      return originalStore.call(this, txid, outputIndex, identityKey, domain, advertisedName);
    };
  };

  patchStorage(SHIPStorage, 'storeSHIPRecord', 'SHIP');
  patchStorage(SLAPStorage, 'storeSLAPRecord', 'SLAP');
  logger.info({
    deniedDomains: [...deniedDomains].sort(),
    deniedCapabilities: [...deniedCapabilities].sort(),
  }, 'Installed SHIP/SLAP discovery denylist');
  return deniedDomains;
}
