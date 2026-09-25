import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('projects', table => {
    table.timestamp('deletion_requested_at').nullable().index();
    table.string('deletion_requested_by', 130).nullable();
    table.timestamp('deletion_attempted_at').nullable();
    table.text('deletion_error').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  if (await knex('projects').whereNotNull('deletion_requested_at').first('id')) {
    throw new Error('Finish pending project deletions before removing their durable intent');
  }
  await knex.schema.alterTable('projects', table => {
    table.dropColumns('deletion_requested_at', 'deletion_requested_by', 'deletion_attempted_at', 'deletion_error');
  });
}
