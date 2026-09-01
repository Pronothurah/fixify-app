/**
 * The escrow-like ledger's other half. `payments` tracks money coming IN
 * from the driver into the platform's wallet; `payouts` tracks money going
 * OUT from that wallet to the vendor (the fare minus platform commission)
 * once the collection succeeds. One row per payout attempt, same
 * attempt-history-preserved pattern as `payments`.
 */
exports.up = function (knex) {
  return knex.schema.createTable('payouts', (table) => {
    table.increments('id');
    table
      .integer('job_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('jobs')
      .onDelete('CASCADE');
    table
      .integer('payment_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('payments')
      .onDelete('CASCADE');
    table
      .integer('vendor_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('vendors')
      .onDelete('CASCADE');
    table.integer('amount').notNullable(); // KES paid to the vendor (net of commission)
    table.integer('commission_amount').notNullable(); // KES kept by the platform
    table.float('commission_rate').notNullable(); // snapshot of the rate used, e.g. 0.15
    table.string('method').notNullable().defaultTo('mpesa');
    table.string('phone'); // vendor number paid out to, snapshot at payout time
    // pending | completed | failed
    table.string('status').notNullable().defaultTo('pending');
    // mock | intasend
    table.string('provider').defaultTo('mock');
    // IntaSend's tracking_id (or the mock equivalent) — how a callback is matched back to this row
    table.string('provider_reference');
    table.text('failure_reason');
    table.timestamp('initiated_at').defaultTo(knex.fn.now());
    table.timestamp('completed_at');
    table.timestamp('failed_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('payouts');
};
