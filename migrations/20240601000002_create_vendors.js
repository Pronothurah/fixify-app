exports.up = function (knex) {
  return knex.schema.createTable('vendors', (table) => {
    table.increments('id');
    table.string('name').notNullable();
    table.string('business_name').notNullable();
    table.string('vehicle_type').notNullable();
    table.string('phone');
    table.float('rating').defaultTo(4.5);
    table.float('lat').notNullable();
    table.float('lng').notNullable();
    table.string('neighborhood');
    table.string('plate');
    table.string('icon').defaultTo('🔧');
    // available | busy | offline
    table.string('status').notNullable().defaultTo('available');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('vendors');
};
