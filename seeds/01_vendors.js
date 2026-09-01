/**
 * Seed data: sample vendors with real (approximate) coordinates so
 * haversine matching produces realistic distances. Coordinates are
 * centroid approximations, not survey-grade GPS.
 *
 * NAMED (first 14) — the original hand-written set from earlier phases,
 * kept exactly as-is (same phone numbers) since the README's demo
 * checklist and prior testing reference them directly (e.g.
 * +254712000003 for Grace Wanjiru in CBD).
 *
 * GENERATED (the rest) — every area in src/neighborhoods.js's
 * NEIGHBORHOODS list gets a real pool of vendors, not just the ~14 areas
 * the named set happened to cover. Pulling area coordinates from that same
 * module (rather than duplicating lat/lng by hand again) means this can
 * never drift out of sync with the location-coverage work — add an area
 * there and vendors for it appear here automatically next reseed.
 * High-traffic hubs (CBD, Westlands, etc.) get a slightly larger pool than
 * quieter areas, same intuition as real vendor density.
 */
const { NEIGHBORHOODS } = require('../src/neighborhoods');

const SERVICE_TYPES = ['tire', 'towing', 'engine', 'battery', 'fuel', 'accident', 'other'];

const HIGH_DENSITY_AREAS = [
  'CBD', 'Westlands', 'Kilimani', 'Karen', 'Kileleshwa', 'Langata', 'Kasarani', 'Thika', 'Ngong',
];

const FIRST_NAMES_M = [
  'James', 'Peter', 'Samuel', 'David', 'Daniel', 'Joseph', 'Simon', 'Francis', 'John', 'Paul',
  'Stephen', 'Michael', 'Anthony', 'Charles', 'George', 'Patrick', 'Dennis', 'Kevin', 'Brian', 'Eric',
  'Vincent', 'Martin', 'Bernard', 'Edwin', 'Felix', 'Geoffrey', 'Isaac', 'Julius', 'Kennedy', 'Lawrence',
];
const FIRST_NAMES_F = [
  'Grace', 'Mary', 'Fatuma', 'Alice', 'Esther', 'Jane', 'Faith', 'Ann', 'Lucy', 'Sarah',
  'Joyce', 'Beatrice', 'Catherine', 'Elizabeth', 'Winnie', 'Nancy', 'Agnes', 'Caroline', 'Diana', 'Eunice',
  'Florence', 'Gladys', 'Irene', 'Josephine', 'Margaret', 'Naomi', 'Rose', 'Susan', 'Teresia', 'Veronica',
];
const LAST_NAMES = [
  'Mwangi', 'Otieno', 'Wanjiru', 'Kamau', 'Hassan', 'Kiprotich', 'Ngige', 'Njeri', 'Wambui', 'Kiplagat',
  'Nyambura', 'Mutiso', 'Mueni', 'Odhiambo', 'Wafula', 'Cheruiyot', 'Njoroge', 'Achieng', 'Onyango', 'Muthoni',
  'Kariuki', 'Wekesa', 'Omondi', 'Wairimu', 'Kipchoge', 'Auma', 'Barasa', 'Chebet', 'Gitau', 'Kilonzo',
  'Maina', 'Ndungu', 'Okoth', 'Rotich', 'Simiyu', 'Wanjala',
];

const VEHICLE_OPTIONS = [
  { vehicle_type: 'Tow Truck', icon: '🚛' },
  { vehicle_type: 'Flatbed Tow Truck', icon: '🚛' },
  { vehicle_type: 'Service Van', icon: '🔧' },
  { vehicle_type: 'Pickup + Tools', icon: '🔧' },
  { vehicle_type: 'Response Motorbike', icon: '🏍️' },
];

const BUSINESS_TEMPLATES = [
  (area) => `${area} Auto Rescue`,
  (area) => `${area} Rapid Response`,
  (area) => `${area} Roadside Help`,
  (area) => `${area} Motors Rescue`,
  (area) => `QuickFix ${area}`,
  (area) => `${area} Towing Services`,
  (area) => `${area} Emergency Auto Care`,
  (area) => `${area} Auto Care`,
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function jitter() {
  return (Math.random() - 0.5) * 0.025; // roughly +/-1.4km, keeps vendors spread within their area
}

function randomPlate() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // skip I/O, matches real Kenyan plates
  const l = () => letters[Math.floor(Math.random() * letters.length)];
  const num = 100 + Math.floor(Math.random() * 900);
  return `K${l()}${l()} ${num}${l()}`;
}

function randomServices() {
  const shuffled = [...SERVICE_TYPES].sort(() => Math.random() - 0.5);
  const count = 2 + Math.floor(Math.random() * 3); // 2-4 services
  return shuffled.slice(0, count);
}

function randomRating() {
  return Math.round((4.3 + Math.random() * 0.7) * 10) / 10; // 4.3-5.0
}

// Continues the phone/ID sequence used by the 14 named vendors below
// (+254712000001..014), so nothing collides.
let phoneCounter = 15;
let idCounter = 30000015;

function generateVendor(area) {
  const isFemale = Math.random() < 0.5;
  const firstName = pick(isFemale ? FIRST_NAMES_F : FIRST_NAMES_M);
  const lastName = pick(LAST_NAMES);
  const { vehicle_type, icon } = pick(VEHICLE_OPTIONS);

  const vendor = {
    name: `${firstName} ${lastName}`,
    business_name: pick(BUSINESS_TEMPLATES)(area.name),
    vehicle_type,
    phone: `+254712${String(phoneCounter++).padStart(6, '0')}`,
    rating: randomRating(),
    lat: area.lat + jitter(),
    lng: area.lng + jitter(),
    neighborhood: area.name,
    plate: randomPlate(),
    icon,
    approval_status: 'approved',
    id_number: String(idCounter++),
    services: randomServices(),
  };
  return vendor;
}

exports.seed = async function (knex) {
  // Clear in FK-safe order.
  await knex('vendor_services').del();
  await knex('jobs').del();
  await knex('vendors').del();
  await knex('users').del();

  const namedVendors = [
    {
      name: 'James Mwangi',
      business_name: 'Mwangi Auto Rescue',
      vehicle_type: 'Tow Truck',
      phone: '+254712000001',
      rating: 4.9,
      lat: -1.2673,
      lng: 36.8065,
      neighborhood: 'Westlands',
      plate: 'KDD 214J',
      icon: '🚛',
      approval_status: 'approved',
      id_number: '23456781',
      services: ['towing', 'accident', 'engine'],
    },
    {
      name: 'Peter Otieno',
      business_name: 'Otieno Towing Services',
      vehicle_type: 'Flatbed Tow Truck',
      phone: '+254712000002',
      rating: 4.7,
      lat: -1.2921,
      lng: 36.7820,
      neighborhood: 'Kilimani',
      plate: 'KCX 552B',
      icon: '🚛',
      approval_status: 'approved',
      id_number: '24567892',
      services: ['towing', 'accident'],
    },
    {
      name: 'Grace Wanjiru',
      business_name: 'QuickFix Tire & Auto',
      vehicle_type: 'Service Van',
      phone: '+254712000003',
      rating: 4.8,
      lat: -1.2864,
      lng: 36.8172,
      neighborhood: 'CBD',
      plate: 'KDA 887M',
      icon: '🔧',
      approval_status: 'approved',
      id_number: '25678903',
      services: ['tire', 'battery', 'fuel', 'other'],
    },
    {
      name: 'Samuel Kamau',
      business_name: 'Kamau Motors Rescue',
      vehicle_type: 'Pickup + Tools',
      phone: '+254712000004',
      rating: 4.6,
      lat: -1.2793,
      lng: 36.7690,
      neighborhood: 'Lavington',
      plate: 'KBZ 331T',
      icon: '🔧',
      approval_status: 'approved',
      id_number: '26789014',
      services: ['engine', 'battery', 'tire', 'other'],
    },
    {
      name: 'Fatuma Hassan',
      business_name: 'Hassan Roadside Solutions',
      vehicle_type: 'Response Motorbike',
      phone: '+254712000005',
      rating: 4.9,
      lat: -1.2611,
      lng: 36.8172,
      neighborhood: 'Parklands',
      plate: 'KDF 552P',
      icon: '🏍️',
      approval_status: 'approved',
      id_number: '27890125',
      services: ['tire', 'battery', 'fuel'],
    },
    {
      name: 'David Kiprotich',
      business_name: 'Kip Auto Repair',
      vehicle_type: 'Service Van',
      phone: '+254712000006',
      rating: 4.5,
      lat: -1.3194,
      lng: 36.7085,
      neighborhood: 'Karen',
      plate: 'KDG 774R',
      icon: '🔧',
      approval_status: 'approved',
      id_number: '28901236',
      services: ['engine', 'tire', 'other'],
    },
    {
      name: 'Daniel Ngige',
      business_name: 'Ngige Emergency Towing',
      vehicle_type: 'Tow Truck',
      phone: '+254712000007',
      rating: 4.8,
      lat: -1.2963,
      lng: 36.8172,
      neighborhood: 'Upperhill',
      plate: 'KDJ 190N',
      icon: '🚛',
      approval_status: 'approved',
      id_number: '29012347',
      services: ['towing', 'accident'],
    },
    {
      name: 'Mary Njeri',
      business_name: 'South B Rapid Response',
      vehicle_type: 'Service Van',
      phone: '+254712000008',
      rating: 4.7,
      lat: -1.3167,
      lng: 36.8283,
      neighborhood: 'South B',
      plate: 'KDL 462S',
      icon: '🔋',
      approval_status: 'approved',
      id_number: '20123458',
      services: ['battery', 'fuel', 'tire'],
    },
    // --- Wider metro area (Kiambu / Kajiado / Machakos) ---
    {
      name: 'Joseph Mwangi',
      business_name: 'Thika Highway Rescue',
      vehicle_type: 'Tow Truck',
      phone: '+254712000009',
      rating: 4.6,
      lat: -1.0333,
      lng: 37.0693,
      neighborhood: 'Thika',
      plate: 'KDN 118T',
      icon: '🚛',
      approval_status: 'approved',
      id_number: '21234569',
      services: ['towing', 'accident', 'engine'],
    },
    {
      name: 'Alice Wambui',
      business_name: 'Ruiru Auto Care',
      vehicle_type: 'Service Van',
      phone: '+254712000010',
      rating: 4.5,
      lat: -1.1500,
      lng: 36.9583,
      neighborhood: 'Ruiru',
      plate: 'KDP 224R',
      icon: '🔧',
      approval_status: 'approved',
      id_number: '22345670',
      services: ['tire', 'battery', 'engine'],
    },
    {
      // fixed: previously duplicated James Mwangi's id_number (23456781)
      name: 'Simon Kiplagat',
      business_name: 'Ngong Roadside Help',
      vehicle_type: 'Pickup + Tools',
      phone: '+254712000011',
      rating: 4.8,
      lat: -1.3667,
      lng: 36.6500,
      neighborhood: 'Ngong',
      plate: 'KDQ 331N',
      icon: '🔧',
      approval_status: 'approved',
      id_number: '31234571',
      services: ['tire', 'engine', 'battery', 'other'],
    },
    {
      // fixed: previously duplicated Peter Otieno's id_number (24567892)
      name: 'Esther Nyambura',
      business_name: 'Rongai Rapid Response',
      vehicle_type: 'Response Motorbike',
      phone: '+254712000012',
      rating: 4.7,
      lat: -1.3959,
      lng: 36.7539,
      neighborhood: 'Rongai',
      plate: 'KDR 442R',
      icon: '🏍️',
      approval_status: 'approved',
      id_number: '31245682',
      services: ['tire', 'battery', 'fuel'],
    },
    {
      // fixed: previously duplicated Grace Wanjiru's id_number (25678903)
      name: 'Daniel Mutiso',
      business_name: 'Kitengela Towing Services',
      vehicle_type: 'Flatbed Tow Truck',
      phone: '+254712000013',
      rating: 4.6,
      lat: -1.4740,
      lng: 36.9570,
      neighborhood: 'Kitengela',
      plate: 'KDS 553K',
      icon: '🚛',
      approval_status: 'approved',
      id_number: '31256793',
      services: ['towing', 'accident'],
    },
    {
      // fixed: previously duplicated Samuel Kamau's id_number (26789014)
      name: 'Grace Mueni',
      business_name: 'Machakos Motors Rescue',
      vehicle_type: 'Service Van',
      phone: '+254712000014',
      rating: 4.9,
      lat: -1.5177,
      lng: 37.2634,
      neighborhood: 'Machakos',
      plate: 'KDT 664M',
      icon: '🔧',
      approval_status: 'approved',
      id_number: '31267804',
      services: ['tire', 'engine', 'battery', 'fuel', 'other'],
    },
  ];

  const generatedVendors = [];
  for (const area of NEIGHBORHOODS) {
    const count = HIGH_DENSITY_AREAS.includes(area.name) ? 3 : 2;
    for (let i = 0; i < count; i++) {
      generatedVendors.push(generateVendor(area));
    }
  }

  const vendors = [...namedVendors, ...generatedVendors];

  for (const v of vendors) {
    const { services, ...vendorRow } = v;
    const [vendorId] = await knex('vendors').insert(vendorRow);
    await knex('vendor_services').insert(
      services.map((service_type) => ({ vendor_id: vendorId, service_type }))
    );
  }

  console.log(`   Seeded ${vendors.length} vendors across ${NEIGHBORHOODS.length} areas`);
};
