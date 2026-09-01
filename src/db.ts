import Knex from 'knex';
import { join } from 'node:path';

function connectionConfig() {
    if (process.env.MYSQL_DATABASE_URL) return process.env.MYSQL_DATABASE_URL;
    if (process.env.NODE_ENV === 'production') {
        throw new Error('MYSQL_DATABASE_URL is required in production');
    }
    return {
        host: 'localhost',
        user: 'cars_user',
        password: 'cars_dev_only',
        database: 'cars_db'
    };
}

const knexConfig = {
    client: 'mysql2',
    connection: connectionConfig(),
    migrations: {
        directory: process.env.CARS_MIGRATIONS_DIR || join(__dirname, 'migrations')
    }
};

const db = Knex(knexConfig);

export default db;
