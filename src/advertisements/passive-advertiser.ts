import { PushDrop, type Script, type TaggedBEEF, Utils } from '@bsv/sdk';
import type { Advertisement, Advertiser } from '@bsv/overlay';

/**
 * Keeps SHIP-based propagation available without giving a project backend the
 * ability to create, discover, or revoke advertisements. Advertisement writes
 * are owned exclusively by the CARS advertisement controller.
 */
export class PassiveAdvertiser implements Advertiser {
  async createAdvertisements(): Promise<TaggedBEEF> {
    throw new Error('SHIP/SLAP advertisements are managed by the CARS node');
  }

  async findAllAdvertisements(): Promise<Advertisement[]> {
    return [];
  }

  async revokeAdvertisements(): Promise<TaggedBEEF> {
    throw new Error('SHIP/SLAP advertisements are managed by the CARS node');
  }

  parseAdvertisement(outputScript: Script): Advertisement {
    const result = PushDrop.decode(outputScript);
    if (result.fields.length < 4) {
      throw new Error('Invalid SHIP/SLAP advertisement');
    }
    const protocol = Utils.toUTF8(result.fields[0]);
    if (protocol !== 'SHIP' && protocol !== 'SLAP') {
      throw new Error('Invalid SHIP/SLAP protocol');
    }
    return {
      protocol,
      identityKey: Utils.toHex(result.fields[1]),
      domain: Utils.toUTF8(result.fields[2]),
      topicOrService: Utils.toUTF8(result.fields[3]),
    };
  }
}
