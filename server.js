// Must run before any other require — src/db.js reads process.env at module
// load time (e.g. DATABASE_URL), so .env has to be loaded first.
require('dotenv').config();

const app = require('./src/app');
const db = require('./src/db');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Run any pending migrations before accepting traffic. This is the single
// biggest source of confusing "it just throws an error" bug reports on a
// project that's picked up new columns/tables across several phases (e.g.
// vendors.approval_status/id_number from Phase 3, notifications from Phase
// 4, payments from Phase 5) — if `npm run migrate` was ever skipped after
// pulling newer code, whichever endpoint touches the newest column fails
// with a raw "SQLITE_ERROR: no such column" instead of anything readable.
// Migrations are additive and idempotent (knex tracks what's already run),
// so doing this on every boot is safe — it's a no-op once the schema is
// current.
async function ensureDatabaseIsCurrent() {
  const [batchNo, log] = await db.migrate.latest();
  if (log.length) {
    console.log(
      `\n📦 Applied ${log.length} pending migration(s) (batch ${batchNo}):\n   ${log
        .map((file) => path.basename(file))
        .join('\n   ')}\n`
    );
  }
}

ensureDatabaseIsCurrent()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🛠️  Fixify backend running at http://localhost:${PORT}`);
      console.log(`   Open that URL in your browser to use the demo app.\n`);
    });
  })
  .catch((err) => {
    console.error('\n❌ Failed to prepare the database on startup:', err.message);
    console.error('   Try running `npm run migrate` manually to see the full error, then `npm start` again.\n');
    process.exit(1);
  });
