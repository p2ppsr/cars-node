import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('cars_payment_replay_claims', table => {
    table.string('transaction_id', 64).primary();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now()).index();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cars_payment_replay_claims');
}
