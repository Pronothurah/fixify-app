/**
 * "Users" here means drivers requesting help. There is no auth yet
 * (see README Phase 3), so a row is created the first time a name/phone
 * is seen.
 */
exports.up = function (knex) {
  return knex.schema.createTable('users', (table) => {
    table.increments('id');
    table.string('name').notNullable();
    table.string('phone');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('users');
};
