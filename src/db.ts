import Knex from 'knex';
import { join } from 'node:path';

const knexConfig = {
    client: 'mysql2',
    connection: process.env.MYSQL_DATABASE_URL || {
        host: 'localhost',
        user: 'cars_user',
        password: 'cars_pass',
        database: 'cars_db'
    },
    migrations: {
        directory: process.env.CARS_MIGRATIONS_DIR || join(__dirname, 'migrations')
    }
};

const db = Knex(knexConfig);

export default db;
