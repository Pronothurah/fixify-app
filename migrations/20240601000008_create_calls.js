/**
 * A job has exactly one driver and one vendor, so a call is scoped to the
 * job plus who placed it (caller_type) — no separate caller/callee id
 * columns needed; the other party is whichever role isn't caller_type.
 * Lifecycle: ringing -> connected -> ended, or ringing -> declined.
 */
exports.up = function (knex) {
  return knex.schema.createTable('calls', (table) => {
    table.increments('id');
    table
      .integer('job_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('jobs')
      .onDelete('CASCADE');
    // 'driver' | 'vendor' — who placed the call; the other side is the callee
    table.string('caller_type').notNullable();
    // ringing | connected | declined | ended
    table.string('status').notNullable().defaultTo('ringing');
    table.timestamp('connected_at');
    table.timestamp('ended_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('calls');
};
