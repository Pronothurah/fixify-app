/**
 * Vendor matching logic.
 *
 * Real geolocation-based ranking using the haversine formula — no external
 * maps API needed. Given a driver's lat/lng and a requested service type,
 * this finds available vendors offering that service and ranks them by
 * straight-line distance, then estimates a drive ETA and a rough price.
 *
 * NOTE: ETA and pricing are simple heuristics (avg speed + flat per-km
 * rate), not real routing. Swapping in a real routing/maps API later only
 * requires changing estimateEtaMinutes/estimatePrice — the ranking query
 * and API contract stay the same.
 */

const EARTH_RADIUS_KM = 6371;
const AVG_SPEED_KMH = 28; // rough Nairobi urban-traffic-adjusted average
const BASE_FARE_KES = 500;
const PER_KM_RATE_KES = 250;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function estimateEtaMinutes(distanceKm) {
  return Math.max(3, Math.round((distanceKm / AVG_SPEED_KMH) * 60));
}

function estimatePrice(distanceKm) {
  const raw = BASE_FARE_KES + distanceKm * PER_KM_RATE_KES;
  return Math.round(raw / 50) * 50; // round to nearest 50 KES
}

/**
 * Rank available vendors offering `serviceType` by distance to (lat, lng).
 * @param {import('knex').Knex} db
 * @param {{lat:number,lng:number,serviceType:string,excludeVendorIds?:number[],limit?:number}} opts
 */
async function rankVendors(db, { lat, lng, serviceType, excludeVendorIds = [], limit = 5 }) {
  let query = db('vendors')
    .join('vendor_services', 'vendors.id', 'vendor_services.vendor_id')
    .where('vendor_services.service_type', serviceType)
    .where('vendors.status', 'available')
    .where('vendors.approval_status', 'approved')
    .select('vendors.*');

  if (excludeVendorIds.length) {
    query = query.whereNotIn('vendors.id', excludeVendorIds);
  }

  const candidates = await query;

  const ranked = candidates
    .map((v) => {
      const distanceKm = haversineKm(lat, lng, v.lat, v.lng);
      return {
        ...v,
        distance_km: Math.round(distanceKm * 10) / 10,
        eta_minutes: estimateEtaMinutes(distanceKm),
        price_estimate: estimatePrice(distanceKm),
      };
    })
    .sort((a, b) => a.distance_km - b.distance_km);

  return ranked.slice(0, limit);
}

module.exports = {
  haversineKm,
  estimateEtaMinutes,
  estimatePrice,
  rankVendors,
};
