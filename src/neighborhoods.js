/**
 * Lightweight neighborhood -> lat/lng resolver used when a vendor
 * self-registers with a coverage area name instead of raw GPS coordinates.
 * Coordinates are approximate town/neighborhood centroids, not survey-grade
 * GPS — fine for MVP-stage matching, not for real turn-by-turn routing.
 *
 * Covers Nairobi County itself plus the wider Nairobi Metropolitan Area —
 * the satellite towns in neighboring counties (Kiambu, Kajiado, Machakos)
 * that a real Nairobi-based roadside assistance pilot needs to reach:
 * Thika/Ruiru/Juja/Kiambu/Limuru/Kikuyu (Kiambu), Ngong/Rongai/Kitengela/
 * Kiserian (Kajiado), Machakos/Athi River (Machakos). `region` records
 * which county so the driver-facing location label is accurate (a match in
 * Thika is Kiambu, not Nairobi).
 *
 * A small random jitter is applied so multiple vendors registering in the
 * same area don't stack on the exact same point.
 */
const NEIGHBORHOODS = [
  // --- Nairobi County ---
  { name: 'Westlands', lat: -1.2673, lng: 36.8065, region: 'Nairobi' },
  { name: 'Kilimani', lat: -1.2921, lng: 36.7820, region: 'Nairobi' },
  { name: 'CBD', lat: -1.2864, lng: 36.8172, region: 'Nairobi' },
  { name: 'Karen', lat: -1.3194, lng: 36.7085, region: 'Nairobi' },
  { name: 'Lavington', lat: -1.2793, lng: 36.7690, region: 'Nairobi' },
  { name: 'Parklands', lat: -1.2611, lng: 36.8172, region: 'Nairobi' },
  { name: 'South B', lat: -1.3167, lng: 36.8283, region: 'Nairobi' },
  { name: 'South C', lat: -1.3100, lng: 36.8270, region: 'Nairobi' },
  { name: 'Upperhill', lat: -1.2963, lng: 36.8172, region: 'Nairobi' },
  { name: 'Kileleshwa', lat: -1.2833, lng: 36.7757, region: 'Nairobi' },
  { name: 'Kitisuru', lat: -1.2200, lng: 36.7900, region: 'Nairobi' },
  { name: 'Runda', lat: -1.2100, lng: 36.8100, region: 'Nairobi' },
  { name: 'Gigiri', lat: -1.2330, lng: 36.8110, region: 'Nairobi' },
  { name: 'Kabete', lat: -1.2500, lng: 36.7350, region: 'Nairobi' },
  { name: 'Ngong Road', lat: -1.3000, lng: 36.7833, region: 'Nairobi' },
  { name: 'Dagoretti', lat: -1.3000, lng: 36.7500, region: 'Nairobi' },
  { name: 'Langata', lat: -1.3667, lng: 36.7500, region: 'Nairobi' },
  { name: 'Eastleigh', lat: -1.2790, lng: 36.8500, region: 'Nairobi' },
  { name: 'Buruburu', lat: -1.2850, lng: 36.8770, region: 'Nairobi' },
  { name: 'Donholm', lat: -1.2930, lng: 36.8850, region: 'Nairobi' },
  { name: 'Umoja', lat: -1.2820, lng: 36.8890, region: 'Nairobi' },
  { name: 'Kayole', lat: -1.2780, lng: 36.9000, region: 'Nairobi' },
  { name: 'Pipeline', lat: -1.3080, lng: 36.8850, region: 'Nairobi' },
  { name: 'Imara Daima', lat: -1.3350, lng: 36.8700, region: 'Nairobi' },
  { name: 'Embakasi', lat: -1.3250, lng: 36.8950, region: 'Nairobi' },
  { name: 'Ruai', lat: -1.2830, lng: 36.9500, region: 'Nairobi' },
  { name: 'Kasarani', lat: -1.2270, lng: 36.8890, region: 'Nairobi' },
  { name: 'Roysambu', lat: -1.2190, lng: 36.8890, region: 'Nairobi' },
  { name: 'Kahawa', lat: -1.1900, lng: 36.9250, region: 'Nairobi' },
  { name: 'Ruaka', lat: -1.2000, lng: 36.7800, region: 'Nairobi' },

  // --- Kiambu County (northern metro environs) ---
  { name: 'Thika', lat: -1.0333, lng: 37.0693, region: 'Kiambu' },
  { name: 'Ruiru', lat: -1.1500, lng: 36.9583, region: 'Kiambu' },
  { name: 'Juja', lat: -1.1036, lng: 37.0142, region: 'Kiambu' },
  { name: 'Kiambu Town', lat: -1.1714, lng: 36.8356, region: 'Kiambu' },
  { name: 'Limuru', lat: -1.1133, lng: 36.6437, region: 'Kiambu' },
  { name: 'Kikuyu', lat: -1.2470, lng: 36.6650, region: 'Kiambu' },

  // --- Kajiado County (southern/western metro environs) ---
  { name: 'Ngong', lat: -1.3667, lng: 36.6500, region: 'Kajiado' },
  { name: 'Rongai', lat: -1.3959, lng: 36.7539, region: 'Kajiado' },
  { name: 'Kitengela', lat: -1.4740, lng: 36.9570, region: 'Kajiado' },
  { name: 'Kiserian', lat: -1.4297, lng: 36.6942, region: 'Kajiado' },

  // --- Machakos County (eastern metro environs) ---
  { name: 'Machakos', lat: -1.5177, lng: 37.2634, region: 'Machakos' },
  { name: 'Athi River', lat: -1.4557, lng: 36.9770, region: 'Machakos' },
];

function jitter() {
  return (Math.random() - 0.5) * 0.02; // roughly +/-1.1km
}

function resolveNeighborhoodCoords(name) {
  const match = NEIGHBORHOODS.find((n) => n.name.toLowerCase() === String(name || '').toLowerCase());
  const base = match || NEIGHBORHOODS.find((n) => n.name === 'CBD');
  return {
    lat: base.lat + jitter(),
    lng: base.lng + jitter(),
    neighborhood: match ? match.name : base.name,
    region: base.region,
  };
}

module.exports = { NEIGHBORHOODS, resolveNeighborhoodCoords };
