/**
 * Phase 5: payments. One row per payment attempt for a job (a retry after
 * a failed attempt creates a new row rather than mutating the old one, so
 * the full attempt history is kept).
 */
exports.up = function (knex) {
  return knex.schema.createTable('payments', (table) => {
    table.increments('id');
    table
      .integer('job_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('jobs')
      .onDelete('CASCADE');
    table.integer('amount').notNullable(); // KES
    table.string('method').notNullable().defaultTo('mpesa');
    table.string('phone'); // number charged
    // pending | completed | failed
    table.string('status').notNullable().defaultTo('pending');
    // mock | daraja
    table.string('provider').defaultTo('mock');
    // Daraja's CheckoutRequestID (or the mock equivalent) — how a callback
    // is matched back to this row.
    table.string('provider_reference');
    // M-Pesa receipt number, populated once completed
    table.string('receipt_number');
    table.timestamp('initiated_at').defaultTo(knex.fn.now());
    table.timestamp('completed_at');
    table.timestamp('failed_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('payments');
};
