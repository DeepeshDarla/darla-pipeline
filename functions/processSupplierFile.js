// processSupplierFile.js
// Main Cloud Function — receives a supplier file from the Drive trigger,
// routes it to the correct parser, writes records to Firebase RTDB.

const functions = require('firebase-functions');
const { parseExcel }     = require('./parsers/excelParser');
const { parseWithAI }    = require('./parsers/pdfParser');
const { writeRecords }   = require('./lib/firebaseWriter');
const { isBlindSupplier } = require('./parsers/supplierConfig');

// Drive folder name → Firebase category key
const FOLDER_TO_CATEGORY = {
  'fabric':        'fabric',
  'fabrics':       'fabric',
  'hangers':       'hangers',
  'hanger':        'hangers',
  'mattress':      'beds',
  'mattresses':    'beds',
  'beds':          'beds',
  'blinds':        'blinds',
  'rods & tracks': 'rods',
  'rods':          'rods',
  'wallpapers':    'wallpapers',
  'wallpaper':     'wallpapers',
  'motors':        'motors',
  'flooring':      'flooring',
};

exports.processSupplierFile = functions
  .region('asia-southeast1')
  .runWith({ timeoutSeconds: 300, memory: '1GB' })
  .https.onRequest(async (req, res) => {

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { filename, folder, brand, mimeType, fileContent } = req.body;

    if (!filename || !folder || !fileContent) {
      return res.status(400).json({ error: 'Missing required fields: filename, folder, fileContent' });
    }

    const category = FOLDER_TO_CATEGORY[folder.toLowerCase()];
    if (!category) {
      return res.status(400).json({ error: `Unknown folder "${folder}". Add it to FOLDER_TO_CATEGORY.` });
    }

    const fileBuffer = Buffer.from(fileContent, 'base64');
    const isExcel    = filename.endsWith('.xlsx') || filename.endsWith('.xls') || filename.endsWith('.xlsm');
    const isPdf      = filename.endsWith('.pdf');
    const isDocx     = filename.endsWith('.docx');

    let records;
    let parserUsed;

    try {
      // Blinds always use AI (complex nested structure)
      const useAI = isBlindSupplier(brand, category);

      if (isExcel && !useAI) {
        try {
          // Try smart rule-based parser first — free and instant
          records    = parseExcel(fileBuffer, filename, category, brand);
          parserUsed = 'excel-rule-based';
        } catch (e) {
          if (e.code === 'UNKNOWN_FORMAT') {
            // Column detection failed — fall back to AI
            console.log(`[processSupplierFile] Rule-based failed for "${filename}": ${e.message}`);
            records    = await parseWithAI(fileBuffer, filename, category, mimeType, brand);
            parserUsed = 'ai-excel-fallback';
          } else {
            throw e;
          }
        }
      } else {
        // PDFs, Word docs, and blinds always use AI
        records    = await parseWithAI(fileBuffer, filename, category, mimeType, brand);
        parserUsed = 'ai';
      }

      if (!records || records.length === 0) {
        return res.status(422).json({ error: 'Parser returned zero records. Check the file.' });
      }

      // Group records by category — a single Excel file may have sheets
      // for different categories (e.g. Fabric + Wallpaper in one file)
      const byCategory = {};
      for (const record of records) {
        const cat = record.category || category;
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(record);
      }

      let totalWritten = 0;
      const categoryBreakdown = [];
      for (const [cat, catRecords] of Object.entries(byCategory)) {
        const result = await writeRecords(catRecords, cat);
        totalWritten += result.written;
        categoryBreakdown.push(`${cat}:${result.written}`);
      }

      console.log(`[processSupplierFile] ✓ ${filename} → ${totalWritten} records across [${categoryBreakdown.join(', ')}] (${parserUsed})`);

      return res.status(200).json({
        success:         true,
        filename,
        category,
        brand,
        parser:          parserUsed,
        records_written: totalWritten,
        categories:      categoryBreakdown,
      });

    } catch (err) {
      console.error('[processSupplierFile] Error:', err);
      return res.status(500).json({ error: err.message });
    }
  });