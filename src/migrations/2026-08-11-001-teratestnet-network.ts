import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
    await knex.schema.alterTable('projects', table => {
        table.string('network', 12).notNullable().alter();
    });
}

export async function down(knex: Knex): Promise<void> {
    const teratestnetProject = await knex('projects')
        .where({ network: 'teratestnet' })
        .first('id');
    if (teratestnetProject) {
        throw new Error('Cannot shrink projects.network while TerraTestNet projects exist');
    }
    await knex.schema.alterTable('projects', table => {
        table.string('network', 7).notNullable().alter();
    });
}
