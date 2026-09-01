// Shared across the jobs and vendors routers so the accepted set of service
// types can't drift between "what a driver can request" and "what a vendor
// can register to offer."
module.exports = ['tire', 'towing', 'engine', 'battery', 'fuel', 'accident', 'other'];
