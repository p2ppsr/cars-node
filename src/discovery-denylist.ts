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
] as const;

export function normalizeDiscoveryDomain(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

export function discoveryDenylist(value = process.env.CARS_BANNED_AD_DOMAINS): Set<string> {
  const configured = value === undefined ? DEFAULT_DISCOVERY_DENYLIST.join(',') : value;
  return new Set(configured.split(',').map(normalizeDiscoveryDomain).filter(Boolean));
}

/**
 * Overlay discovery treats valid unspent advertisements as synchronizable.
 * A local operator denylist therefore has to guard both Engine retention and
 * Mongo discovery insertion or GASP can restore an evicted record.
 */
export function installDiscoveryDenylist(
  value = process.env.CARS_BANNED_AD_DOMAINS,
  preferredIdentityKey?: string,
): Set<string> {
  const deniedDomains = discoveryDenylist(value);
  if (deniedDomains.size === 0) return deniedDomains;

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
              if (decoded.fields.length < 3) continue;
              const protocol = Utils.toUTF8(decoded.fields[0]);
              if (protocol !== 'SHIP' && protocol !== 'SLAP') continue;
              const domain = normalizeDiscoveryDomain(Utils.toUTF8(decoded.fields[2]));
              if (deniedDomains.has(domain)) {
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
      if (deniedDomains.has(normalizedDomain)) {
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
  logger.info({ deniedDomains: [...deniedDomains].sort() }, 'Installed SHIP/SLAP discovery denylist');
  return deniedDomains;
}
