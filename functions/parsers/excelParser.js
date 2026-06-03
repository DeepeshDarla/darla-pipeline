// excelParser.js
// Smart universal rule-based parser for Excel supplier files.
// Handles THREE formats:
//   1. Mattress matrix  — products as columns, sizes as rows (Sleepwell etc.)
//   2. Standard fabric  — one product per row, standard column headers
//   3. INR merged cells — currency label in one column, price in the next
// Zero AI cost.

const XLSX = require('xlsx');

// ─────────────────────────────────────────────
// Standard column detection patterns
// ─────────────────────────────────────────────
const COLUMN_PATTERNS = {
  catalog:      [/collection\s*name/i, /catalogue\s*name/i, /catalog\s*name/i,
                 /product\s*name/i, /book\s*name/i, /^range$/i,
                 /^collection$/i, /^catalogue$/i, /^catalog$/i, /^collections$/i, /^book\s*names?/i],
  sno:          [/^s\.?\s*no\.?$/i, /^sr\.?\s*no\.?$/i, /^serial/i,
                 /^no\.?$/i, /^sl\.?\s*no/i, /design\s*code/i,
                 /^short\s*sku/i, /^sku\s*code/i, /^sku$/i,
                 /^code$/i, /^article$/i, /^ref/i, /^item\s*no/i, /^file$/i],
  design:       [/^design$/i, /design\s*name/i, /^pattern$/i, /^style$/i,
                 /^item\s*name$/i, /^quality$/i, /^name$/i,
                 /^description$/i, /^article\s*names?/i, /^product\s*name$/i],
  shade:        [/^shade$/i, /^colour$/i, /^color$/i, /shade\s*name/i,
                 /colour\s*name/i],
  cut_rate:     [/cut\s*rate/i, /cut\s*price/i, /cut\s*pr/i,
                 /price\s*per\s*r/i, /price\s*\(?rs/i,
                 /selling\s*price/i, /^price$/i, /unit\s*price/i,
                 /dealer\s*price/i, /net\s*rate/i, /our\s*price/i,
                 /trade\s*price/i, /^cost$/i,
                 /^d\.?p\.?$/i, /^dp\s*\(/i, /^dpl$/i, /^cut$/i,
                 /cut.*mtr/i, /inr.*cut/i],
  roll_rate:    [/roll\s*rate/i, /roll\s*price/i, /bolt\s*rate/i, /^roll$/i, /roll.*mtr/i, /inr.*roll/i],
  rrp:          [/^r\s*r\s*p$/i, /^r\.r\.p$/i, /^rrp\s*\(?/i, /^rrp$/i,
                 /retail.*price/i, /recommended.*retail/i,
                 /mrp.*excl/i, /price.*excl.*gst/i, /without.*gst/i],
  rrp_incl_gst: [/^mrp\s*\(?/i, /^mrp$/i, /rrp.*incl/i,
                 /price.*incl.*gst/i, /incl.*gst/i, /with\s*gst/i,
                 /including\s*gst/i, /\+\s*gst/i, /total.*price/i],
  width_cm:     [/width/i, /^w\s*\(?cm\)?/i],
  hsn_code:     [/^hsn/i, /h\.?s\.?\s*(code|tariff)/i,
                 /hs\s*\/\s*tariff/i, /tariff/i, /sac\s*code/i],
  gst_pct:           [/gst\s*%/i, /gst\s*rate/i, /tax\s*rate/i, /^gst$/i],
  cut_rate_incl_gst: [/dp.*inc/i, /inc.*tax/i, /rate.*incl/i, /price.*incl.*tax/i],
  composition:  [/content/i, /composition/i, /^material$/i,
                 /fibre/i, /fiber/i],
};

const GST_DEFAULTS = {
  fabric: 5, hangers: 5, mattress: 12, beds: 12,
  blinds: 18, rods: 18, wallpapers: 18, flooring: 18, motors: 18,
};

// ─────────────────────────────────────────────
// Sheet name → category override
// If a sheet is named "Wallpaper", route those records to wallpapers
// even if the file was uploaded to the Fabric folder
// ─────────────────────────────────────────────
const SHEET_CATEGORY_MAP = [
  { pattern: /wallpaper/i,           category: 'wallpapers' },
  { pattern: /blind/i,               category: 'blinds'     },
  { pattern: /rod|track/i,           category: 'rods'       },
  { pattern: /mattress|bed/i,        category: 'beds'       },
  { pattern: /flooring|floor/i,      category: 'flooring'   },
  { pattern: /motor/i,               category: 'motors'     },
  { pattern: /fabric|curtain|drap/i, category: 'fabric'     },
];

function detectSheetCategory(sheetName, defaultCategory) {
  const name = (sheetName || '').trim();
  for (const { pattern, category } of SHEET_CATEGORY_MAP) {
    if (pattern.test(name)) return category;
  }
  return defaultCategory;
}

const GENERIC_SHEET_NAMES = [
  'sheet1','sheet2','sheet3','price list','revised price list',
  'prices','data','main','table 1','table1',
];

const CURRENCY_LABELS = /^(inr|rs\.?|₹|usd|\$)\s*$/i;

// ─────────────────────────────────────────────
// MATTRESS MATRIX FORMAT
// Detects: Row 1 starts with Length/Breadth + thickness values from col 3
// ─────────────────────────────────────────────
function isMattressMatrix(rawRows) {
  if (!rawRows || rawRows.length < 3) return false;
  const row1 = rawRows[1] || [];
  const hasLengthBreadth = String(row1[0] || '').match(/length/i) &&
                            String(row1[1] || '').match(/breadth/i);
  const hasThickness = row1.slice(3).some(
    v => v && String(v).match(/\d+.*cm/i)
  );
  return !!(hasLengthBreadth && hasThickness);
}

function parseMattressMatrix(rawRows, sheetName, brandOverride, category, filename, today) {
  const row0 = rawRows[0] || [];
  const row1 = rawRows[1] || [];

  // Build column map: colIndex → { product, thickness }
  const colMap = {};
  let currentProduct = null;

  for (let col = 3; col < Math.max(row0.length, row1.length); col++) {
    const productCell = row0[col];
    if (productCell && String(productCell).trim()) {
      currentProduct = String(productCell).trim();
    }
    const thicknessCell = row1[col];
    if (currentProduct && thicknessCell && String(thicknessCell).trim()) {
      // Extract inches value from e.g. "15.0 cm (6)" → "6 inch"
      const inchMatch = String(thicknessCell).match(/\((\d+)\)/);
      const cmMatch   = String(thicknessCell).match(/(\d+(?:\.\d+)?)\s*cm/i);
      const thickness = inchMatch ? inchMatch[1] + ' inch'
                      : cmMatch   ? cmMatch[1] + 'cm'
                      : String(thicknessCell).trim();
      colMap[col] = { product: currentProduct, thickness };
    }
  }

  if (Object.keys(colMap).length === 0) return [];

  const records = [];

  for (let ri = 2; ri < rawRows.length; ri++) {
    const row = rawRows[ri];
    if (!row) continue;

    // Col 2 = size code in inches (e.g. "72X30")
    const sizeCode = row[2] ? String(row[2]).trim().toUpperCase() : null;
    if (!sizeCode || !sizeCode.match(/^\d+[Xx]\d+$/)) continue;

    const lengthCm  = Number(row[0]) || null;
    const breadthCm = Number(row[1]) || null;

    for (const [colStr, { product, thickness }] of Object.entries(colMap)) {
      const mrp = row[parseInt(colStr)];
      if (mrp == null || isNaN(Number(mrp)) || Number(mrp) === 0) continue;

      records.push({
        brand:        brandOverride || 'Unknown',
        catalog:      product + ' ' + thickness,
        sno:          sizeCode,
        design:       product,
        shade:        null,
        cut_rate:     null,
        roll_rate:    null,
        rrp:          null,
        rrp_incl_gst: Number(mrp),
        width_cm:     breadthCm,
        length_cm:    lengthCm,
        thickness,
        size_code:    sizeCode,
        hsn_code:     '94049090',
        gst_pct:      GST_DEFAULTS[(category || '').toLowerCase()] || 12,
        price_unit:   'per_piece',
        category:     (category || '').toLowerCase(),
        source_file:  filename,
        last_updated: today,
      });
    }
  }

  return records;
}

// ─────────────────────────────────────────────
// STANDARD FORMAT — header row detection
// ─────────────────────────────────────────────
function findHeaderRow(rawRows) {
  const allPatterns = Object.values(COLUMN_PATTERNS).flat();
  let bestRow = null, bestScore = 0;
  for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
    const row = rawRows[i];
    if (!row || !Array.isArray(row)) continue;
    const score = row.filter(
      cell => cell && allPatterns.some(p => p.test(String(cell).trim()))
    ).length;
    if (score > bestScore) { bestScore = score; bestRow = i; }
  }
  return bestScore > 0 ? bestRow : null;
}

function buildPositionMap(headerRow) {
  const posMap = {};
  headerRow.forEach((cell, idx) => {
    if (!cell) return;
    const h = String(cell).trim();
    for (const [field, patterns] of Object.entries(COLUMN_PATTERNS)) {
      if (!posMap[field] && patterns.some(p => p.test(h))) {
        posMap[field] = idx;
      }
    }
  });
  return posMap;
}

function getVal(row, posMap, field) {
  const idx = posMap[field];
  if (idx === undefined || idx === null) return null;
  const val = row[idx];
  // INR / ₹ label in merged cell → real value is in next column
  if (val != null && typeof val === 'string' && CURRENCY_LABELS.test(val.trim())) {
    return row[idx + 1] ?? null;
  }
  return val ?? null;
}

function isUnitsRow(row) {
  const vals = row.filter(v => v != null && String(v).trim() !== '');
  if (vals.length === 0) return false;
  return vals.every(v => {
    const s = String(v).trim();
    return /^\([\w\s.%]+\)$/.test(s) || CURRENCY_LABELS.test(s) || s === '%';
  });
}

// ─────────────────────────────────────────────
// MAIN ENTRY — routes to correct format
// ─────────────────────────────────────────────
function parseExcel(fileBuffer, filename, category, brandOverride) {
  const wb         = XLSX.read(fileBuffer, { type: 'buffer' });
  const allRecords = [];
  const today      = new Date().toISOString().split('T')[0];
  const gstDefault = GST_DEFAULTS[(category || '').toLowerCase()] || 5;
  const fileBase   = filename.replace(/\.xlsx?$/i, '').replace(/_/g, ' ').trim();

  for (const sheetName of wb.SheetNames) {
    const ws      = wb.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    if (!rawRows || rawRows.length === 0) continue;

    // Detect category from sheet name (e.g. "Wallpaper" sheet in a Fabric file)
    const sheetCategory = detectSheetCategory(sheetName, category);

    // ── Route 1: Mattress matrix ──
    if (isMattressMatrix(rawRows)) {
      const matRecords = parseMattressMatrix(
        rawRows, sheetName, brandOverride, sheetCategory, filename, today
      );
      if (matRecords.length > 0) {
        console.log(`[excelParser] Sheet "${sheetName}" → mattress matrix → ${matRecords.length} records`);
        allRecords.push(...matRecords);
        continue;
      }
    }

    // ── Route 2: Standard row-per-product ──
    const headerRowIdx = findHeaderRow(rawRows);
    if (headerRowIdx === null) {
      console.log(`[excelParser] Sheet "${sheetName}" — no recognisable headers, skipping`);
      continue;
    }

    const headerRow = rawRows[headerRowIdx];
    const posMap    = buildPositionMap(headerRow);
    const hasPrice  = posMap.cut_rate  !== undefined ||
                      posMap.rrp       !== undefined ||
                      posMap.rrp_incl_gst !== undefined;

    if (!hasPrice) {
      console.log(`[excelParser] Sheet "${sheetName}" — no price column found, skipping`);
      continue;
    }

    const isGeneric      = GENERIC_SHEET_NAMES.includes(sheetName.toLowerCase().trim());
    const catalogFallback = posMap.catalog !== undefined ? null
                          : isGeneric ? fileBase : sheetName;

    let currentCatalog = catalogFallback;

    for (let ri = headerRowIdx + 1; ri < rawRows.length; ri++) {
      const row = rawRows[ri];
      if (!row || row.every(v => v == null || String(v).trim() === '')) continue;
      if (isUnitsRow(row)) continue;

      const catalogVal  = getVal(row, posMap, 'catalog');
      const cutRateVal  = getVal(row, posMap, 'cut_rate');
      const rollRateVal = getVal(row, posMap, 'roll_rate');
      const rrpVal      = getVal(row, posMap, 'rrp');
      const mrpVal      = getVal(row, posMap, 'rrp_incl_gst');

      if (catalogVal && !num(cutRateVal) && !num(rollRateVal) &&
          !num(rrpVal) && !num(mrpVal)) {
        currentCatalog = str(catalogVal) || currentCatalog;
        continue;
      }

      const catalog  = str(catalogVal) || currentCatalog;
      if (!catalog) continue;

      const cutRate  = num(cutRateVal);
      const rollRate = num(rollRateVal);
      const rrp      = num(rrpVal);
      const mrp      = num(mrpVal);
      if (!cutRate && !rollRate && !rrp && !mrp) continue;

      const gstRaw = getVal(row, posMap, 'gst_pct');
      let gst = gstDefault;
      if (gstRaw != null) {
        const parsed = parseFloat(String(gstRaw).replace('%', ''));
        if (!isNaN(parsed)) gst = parsed < 1 ? Math.round(parsed * 100) : Math.round(parsed);
      }

      // MRP fallback: 1) use stored MRP, 2) RRP + GST%, 3) (cut rate × 2) + GST%
      let rrpInclGst = mrp;
      if (!rrpInclGst && rrp) {
        rrpInclGst = Math.round(rrp * (1 + gst / 100));
      } else if (!rrpInclGst && cutRate) {
        rrpInclGst = Math.round(cutRate * 2 * (1 + gst / 100));
      }

      const snoVal    = getVal(row, posMap, 'sno');
      const designVal = getVal(row, posMap, 'design');
      const sno       = str(snoVal) || str(designVal) || String(allRecords.length + 1);

      allRecords.push({
        brand:        brandOverride || 'Unknown',
        catalog:      String(catalog).trim(),
        sno,
        design:       str(designVal) || sno,
        shade:        str(getVal(row, posMap, 'shade'))       || null,
        roll_rate:    rollRate                                  || null,
        cut_rate:          cutRate                              || null,
        cut_rate_incl_gst: num(getVal(row, posMap, 'cut_rate_incl_gst')) || null,
        rrp:          rrp                                       || null,
        rrp_incl_gst: rrpInclGst                               || null,
        width_cm:     num(getVal(row, posMap, 'width_cm'))     || null,
        hsn_code:     str(getVal(row, posMap, 'hsn_code'))     || null,
        composition:  str(getVal(row, posMap, 'composition'))  || null,
        gst_pct:      gst,
        price_unit:   'per_metre',
        category:     sheetCategory,
        source_file:  filename,
        last_updated: today,
      });
    }
  }

  if (allRecords.length === 0) {
    const err = new Error(`No valid records found in "${filename}". Routing to AI parser.`);
    err.code = 'UNKNOWN_FORMAT';
    throw err;
  }

  console.log(`[excelParser] "${filename}" → ${allRecords.length} records (rule-based, free)`);
  return allRecords;
}

function num(val) {
  if (val == null) return null;
  const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function str(val) {
  if (val == null) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
}

module.exports = { parseExcel };