// firebaseWriter.js
// Writes parsed supplier records to Firebase Realtime Database.
// Handles two schemas automatically:
//   Fabric  — flat fields: roll_rate, cut_rate, rrp, rrp_incl_gst (price per metre)
//   Blinds  — nested:     mechanisms: { key: price }, price per sqft

const admin = require('firebase-admin');

/**
 * Write records to Firebase RTDB.
 * Detects schema type per record (fabric vs blind) and writes accordingly.
 */
async function writeRecords(records, category) {
  const db     = admin.database();
  const cat    = category.toLowerCase();
  const catRef = db.ref(cat);

  if (!records || records.length === 0) {
    console.log(`[firebaseWriter] No records for "${cat}"`);
    return { written: 0, category: cat };
  }

  const updates = {};

  for (const record of records) {
    const brand   = sanitizeKey(record.brand);
    const catalog = sanitizeKey(record.catalog);
    const sno     = sanitizeKey(record.sno);

    if (!brand || !catalog || !sno) {
      console.warn('[firebaseWriter] Skipping — missing brand/catalog/sno:', record);
      continue;
    }

    const data = record.mechanisms
      ? buildBlindRecord(record)
      : buildFabricRecord(record);

    updates[`by_brand/${brand}/${catalog}/${sno}`] = data;
    updates[`by_code/${brand}__${catalog}__${sno}`] = data;
  }

  await catRef.update(updates);
  console.log(`[firebaseWriter] Wrote ${records.length} records to /${cat}/`);

  await rebuildMeta(catRef, cat);
  return { written: records.length, category: cat };
}

function buildFabricRecord(r) {
  return {
    brand:        r.brand,
    catalog:      r.catalog,
    sno:          r.sno,
    design:       r.design        || r.sno,
    shade:        r.shade         || null,
    roll_rate:    r.roll_rate     || null,
    cut_rate:     r.cut_rate      || null,
    rrp:          r.rrp           || null,
    rrp_incl_gst: r.rrp_incl_gst || null,
    width_cm:     r.width_cm      || null,
    hsn_code:     r.hsn_code      || null,
    gst_pct:      r.gst_pct       || 5,
    price_unit:   'per_metre',
    source_file:  r.source_file   || null,
    last_updated: r.last_updated  || todayStr(),
  };
}

function buildBlindRecord(r) {
  // Sanitize and validate mechanisms object
  const mechanisms = r.mechanisms && typeof r.mechanisms === 'object'
    ? Object.fromEntries(
        Object.entries(r.mechanisms)
          .filter(([k, v]) => k && v != null && !isNaN(Number(v)))
          .map(([k, v])    => [sanitizeKey(k), Number(v)])
      )
    : {};

  if (Object.keys(mechanisms).length === 0) {
    console.warn(`[firebaseWriter] Blind record "${r.sno}" has no valid mechanisms`);
  }

  return {
    brand:          r.brand,
    catalog:        r.catalog,
    sno:            r.sno,
    design:         r.design          || r.sno,
    sub_collection: r.sub_collection  || null,
    mechanisms,
    price_unit:     'per_sqft',
    max_width_m:    r.max_width_m     || null,
    max_width_ft:   r.max_width_ft    || null,
    hsn_code:       r.hsn_code        || null,
    gst_pct:        r.gst_pct         || 18,
    source_file:    r.source_file     || null,
    last_updated:   r.last_updated    || todayStr(),
  };
}

async function rebuildMeta(catRef, cat) {
  const snap    = await catRef.child('by_brand').once('value');
  const byBrand = snap.val() || {};
  const meta    = {};

  for (const brand of Object.keys(byBrand)) {
    meta[brand] = {};
    for (const catalog of Object.keys(byBrand[brand])) {
      const entries = byBrand[brand][catalog];
      meta[brand][catalog] = Object.entries(entries).map(([sno, data]) => ({
        sno,
        design:         data.design         || sno,
        shade:          data.shade          || null,
        sub_collection: data.sub_collection || null,
        price_unit:     data.price_unit     || 'per_metre',
        width_cm:       data.width_cm       || null,
        mrp:            data.rrp_incl_gst   || data.rrp || null,
        // First mechanism price for blinds preview
        preview_price: data.mechanisms
          ? Object.values(data.mechanisms)[0] || null
          : data.rrp_incl_gst || data.rrp || data.roll_rate || null,
      }));
    }
  }

  await catRef.child('meta').set(meta);
  console.log(`[firebaseWriter] Rebuilt meta for /${cat}/ — ${Object.keys(meta).length} brands`);
}

function sanitizeKey(str) {
  if (!str) return null;
  return String(str).trim().replace(/[.#$[\]/]/g, '_').substring(0, 200);
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

module.exports = { writeRecords };