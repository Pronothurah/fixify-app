// Knex configuration.
//
// Today this points at a local SQLite file so the whole stack runs with zero
// external setup. When it's time to move to Postgres, you do NOT need to
// rewrite any models, routes, or queries — Knex generates SQL for whichever
// client is configured here. Steps to migrate later:
//   1. npm install pg
//   2. Set DATABASE_URL to your Postgres connection string
//   3. Run with NODE_ENV=production (uses the `production` block below)
//   4. Re-run `npm run migrate` against the new database
//
require('dotenv').config();
const path = require('path');

module.exports = {
  development: {
    client: 'sqlite3',
    connection: {
      filename: path.join(__dirname, 'fixify.sqlite3'),
    },
    useNullAsDefault: true,
    migrations: {
      directory: path.join(__dirname, 'migrations'),
    },
    seeds: {
      directory: path.join(__dirname, 'seeds'),
    },
  },

  // Swap-in config for Postgres. No application code changes required —
  // only this connection block and the DATABASE_URL env var.
  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    migrations: {
      directory: path.join(__dirname, 'migrations'),
    },
    seeds: {
      directory: path.join(__dirname, 'seeds'),
    },
  },
};
