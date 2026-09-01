/**
 * Phase 4: in-app notifications. Every notification is persisted here
 * regardless of which delivery provider handled it (see
 * src/notifications.js) — this is what powers the bell/badge in the
 * frontend, independent of whether real SMS/push is wired up.
 */
exports.up = function (knex) {
  return knex.schema.createTable('notifications', (table) => {
    table.increments('id');
    // 'driver' | 'vendor' — recipient_id points at users.id or vendors.id
    // depending on this column; not a DB-level FK since it targets two
    // different tables.
    table.string('recipient_type').notNullable();
    table.integer('recipient_id').unsigned().notNullable();
    table
      .integer('job_id')
      .unsigned()
      .references('id')
      .inTable('jobs')
      .onDelete('CASCADE');
    // job_request | job_accepted | job_declined | job_en_route |
    // job_completed | job_cancelled | vendor_approved | vendor_rejected
    table.string('type').notNullable();
    table.string('title').notNullable();
    table.text('body');
    // which provider handled delivery: console | africastalking | ...
    table.string('channel').notNullable().defaultTo('console');
    table.string('status').notNullable().defaultTo('sent'); // sent | failed
    table.timestamp('read_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('notifications');
};
