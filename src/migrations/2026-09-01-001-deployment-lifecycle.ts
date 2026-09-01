import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('deploys', table => {
    table.string('status', 32).notNullable().defaultTo('pending').index();
    table.text('error_message').nullable();
    table.timestamp('accepted_at').nullable();
    table.timestamp('completed_at').nullable();
  });

  await knex('deploys')
    .whereNotNull('file_path')
    .update({ status: 'succeeded', completed_at: knex.fn.now() });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('deploys', table => {
    table.dropColumn('completed_at');
    table.dropColumn('accepted_at');
    table.dropColumn('error_message');
    table.dropColumn('status');
  });
}
