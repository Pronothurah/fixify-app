/**
 * Phase 3: vendor self-registration. New vendors land as `pending` and must
 * be approved by an admin before they're eligible for matching (see
 * src/matching.js, which filters on approval_status = 'approved').
 *
 * id_number is a lightweight verification field captured at signup —
 * a National ID number or vehicle plate, reviewed by eye, not a real
 * document/KYC check.
 */
exports.up = function (knex) {
  return knex.schema.alterTable('vendors', (table) => {
    // pending | approved | rejected
    table.string('approval_status').notNullable().defaultTo('pending');
    table.string('id_number');
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('vendors', (table) => {
    table.dropColumn('approval_status');
    table.dropColumn('id_number');
  });
};
