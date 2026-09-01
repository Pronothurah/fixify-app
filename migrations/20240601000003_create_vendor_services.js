/**
 * A vendor can offer multiple service types (e.g. a service van doing
 * tire + battery + fuel). Modeled as a join table rather than a JSON blob
 * so it stays easy to query/index and translates cleanly to Postgres.
 */
exports.up = function (knex) {
  return knex.schema.createTable('vendor_services', (table) => {
    table.increments('id');
    table
      .integer('vendor_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('vendors')
      .onDelete('CASCADE');
    // tire | towing | engine | battery | fuel | accident | other
    table.string('service_type').notNullable();
    table.unique(['vendor_id', 'service_type']);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('vendor_services');
};
