/**
 * Payment now happens when a driver selects a vendor (before the vendor is
 * ever notified/dispatched) rather than after the job completes — see
 * src/routes/jobs.js. That protects vendors from doing unpaid work, but
 * means a driver can now have a completed payment for a job that never
 * finishes (vendor never shows, driver cancels for a legitimate reason).
 * This table tracks refunding that payment back to the driver — one row
 * per refund attempt, same attempt-history-preserved pattern as
 * payments/payouts.
 */
exports.up = function (knex) {
  return knex.schema.createTable('refunds', (table) => {
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
    table.integer('amount').notNullable(); // KES — the full original payment amount, no commission deducted
    table.string('phone'); // driver number refunded to, snapshot at refund time
    // pending | completed | failed
    table.string('status').notNullable().defaultTo('pending');
    // mock | kopokopo | intasend — reuses the same provider as payouts (src/payouts.js)
    table.string('provider').defaultTo('mock');
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
  return knex.schema.dropTableIfExists('refunds');
};
