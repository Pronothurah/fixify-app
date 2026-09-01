/**
 * Status lifecycle: requested -> awaiting_payment -> matched -> accepted ->
 * en_route -> completed. `awaiting_payment` and `matched` were split apart
 * later (see src/routes/jobs.js and src/payments.js) so a vendor is only
 * ever notified about a job — i.e. only reaches 'matched' — once the
 * driver's payment for it has actually cleared; a vendor should never do
 * work against an unpaid request. A job can move to `cancelled` from any
 * non-terminal state (driver cancels, triggering a refund via src/refunds.js
 * if a payment had already completed), and a `matched` job can fall back to
 * `requested` if the vendor declines (declined_vendor_ids tracks who's
 * already said no so they're excluded from the next matching pass) — a
 * re-match after a decline skips `awaiting_payment` since it's already paid.
 */
exports.up = function (knex) {
  return knex.schema.createTable('jobs', (table) => {
    table.increments('id');
    table
      .integer('driver_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table
      .integer('vendor_id')
      .unsigned()
      .references('id')
      .inTable('vendors')
      .onDelete('SET NULL');
    // tire | towing | engine | battery | fuel | accident | other
    table.string('service_type').notNullable();
    // requested | matched | accepted | en_route | completed | cancelled
    table.string('status').notNullable().defaultTo('requested');
    table.float('driver_lat').notNullable();
    table.float('driver_lng').notNullable();
    table.string('location_label');
    table.text('declined_vendor_ids').defaultTo('[]');
    table.integer('price_estimate');
    table.integer('eta_minutes');
    table.float('distance_km');
    table.timestamp('requested_at').defaultTo(knex.fn.now());
    table.timestamp('matched_at');
    table.timestamp('accepted_at');
    table.timestamp('en_route_at');
    table.timestamp('completed_at');
    table.timestamp('cancelled_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('jobs');
};
