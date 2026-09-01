import type { Knex } from 'knex';
import type { PaymentReplayStore } from '@bsv/payment-express-middleware';

export class KnexPaymentReplayStore implements PaymentReplayStore {
  constructor(private readonly db: Knex) {}

  async claim(transactionId: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/i.test(transactionId)) {
      throw new Error('Invalid payment transaction id');
    }
    try {
      await this.db('cars_payment_replay_claims').insert({
        transaction_id: transactionId.toLowerCase(),
      });
      return true;
    } catch (error: any) {
      if (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062) return false;
      throw error;
    }
  }
}
