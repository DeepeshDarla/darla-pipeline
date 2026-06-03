// supplierConfig.js
// With the smart universal Excel parser, most suppliers no longer need
// manual column configuration — the parser detects columns automatically.
//
// This file now only handles two things:
// 1. Identifying which suppliers are BLINDS (so the right prompt/schema is used)
// 2. Any supplier-specific overrides if auto-detection ever fails

// Suppliers that should use the BLINDS schema (nested mechanisms, per sqft)
// All others default to FABRIC schema (flat, per metre)
const BLINDS_SUPPLIERS = [
  'adorn decor',
  'adorn',
  // add more blinds suppliers here as needed
];

// Categories that always use blinds schema regardless of supplier
const BLINDS_CATEGORIES = ['blinds', 'rods', 'motors'];

/**
 * Returns true if this supplier+category combination should use the blinds schema
 */
function isBlindSupplier(brandName, category) {
  const cat   = (category || '').toLowerCase();
  const brand = (brandName || '').toLowerCase();
  return BLINDS_CATEGORIES.includes(cat) ||
         BLINDS_SUPPLIERS.some(s => brand.includes(s));
}

module.exports = { isBlindSupplier };