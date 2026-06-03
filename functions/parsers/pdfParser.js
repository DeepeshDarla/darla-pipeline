// pdfParser.js
// AI-based parser for PDF, Word, Excel (unknown supplier), and multi-sheet files.
// Selects the correct extraction prompt based on the product category.

const Anthropic = require('@anthropic-ai/sdk');
const pdfParse  = require('pdf-parse');
const mammoth   = require('mammoth');
const XLSX      = require('xlsx');

const { FABRIC_SYSTEM_PROMPT } = require('./prompts/fabricPrompt');
const { BLINDS_SYSTEM_PROMPT } = require('./prompts/blindsPrompt');

// Uses ANTHROPIC_API_KEY from .env file
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Categories that use the blinds schema (nested mechanisms, per_sqft)
const BLINDS_CATEGORIES = ['blinds', 'rods', 'motors'];

// Categories that use the fabric schema (flat, per_metre)
const FABRIC_CATEGORIES = ['fabric', 'hangers', 'wallpapers', 'flooring', 'beds', 'mattress'];

/**
 * Select the right system prompt based on category.
 */
function getPrompt(category) {
  const cat = (category || '').toLowerCase();
  if (BLINDS_CATEGORIES.includes(cat)) return BLINDS_SYSTEM_PROMPT;
  return FABRIC_SYSTEM_PROMPT;
}

/**
 * Extract text from a PDF buffer.
 */
async function extractPdfText(buffer) {
  const result = await pdfParse(buffer);
  return result.text;
}

/**
 * Extract text from a Word (.docx) buffer.
 */
async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/**
 * Extract text from an Excel buffer — all sheets, clearly labelled.
 * Produces tab-separated rows under "=== Sheet: SheetName ===" headers.
 */
function extractExcelText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const lines = [];

  for (const sheetName of wb.SheetNames) {
    const ws   = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    lines.push(`\n=== Sheet: ${sheetName} ===`);
    for (const row of rows) {
      const line = row.map(c => String(c).trim()).join('\t');
      if (line.replace(/\t/g, '').trim()) lines.push(line);
    }
  }

  return lines.join('\n');
}

/**
 * Parse a supplier file using the Claude API.
 * Handles PDF, Word (.docx), and Excel (unknown/multi-sheet formats).
 */
async function parseWithAI(fileBuffer, filename, category, mimeType, brandOverride) {
  let text;

  const isExcel = filename.endsWith('.xlsx') || filename.endsWith('.xls') ||
                  filename.endsWith('.xlsm') ||
                  mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
                  mimeType === 'application/vnd.ms-excel';

  const isPdf  = filename.endsWith('.pdf') || mimeType === 'application/pdf';
  const isDocx = filename.endsWith('.docx') ||
                 mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  if (isExcel) {
    text = extractExcelText(fileBuffer);
  } else if (isPdf) {
    text = await extractPdfText(fileBuffer);
  } else if (isDocx) {
    text = await extractDocxText(fileBuffer);
  } else {
    text = fileBuffer.toString('utf-8');
  }

  if (!text || text.trim().length < 50) {
    throw new Error(`Could not extract readable text from "${filename}"`);
  }

  const systemPrompt = getPrompt(category);
  const isBlind = BLINDS_CATEGORIES.includes((category || '').toLowerCase());

  console.log(`[pdfParser] "${filename}" → ${isBlind ? 'BLINDS' : 'FABRIC'} prompt | ${text.length} chars`);

  const response = await client.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 16000,
    system:     systemPrompt,
    messages:   [{
      role:    'user',
      content: `Extract all product records from this supplier price list:\n\n${text}`,
    }],
  });

  const raw = response.content[0]?.text || '';

  let records;
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    records = JSON.parse(clean);
  } catch (e) {
    throw new Error(`Claude API returned invalid JSON for "${filename}": ${e.message}`);
  }

  if (!Array.isArray(records)) {
    throw new Error(`Expected JSON array, got: ${typeof records}`);
  }

  const today = new Date().toISOString().split('T')[0];

  return records.map(r => ({
    ...r,
    brand:        brandOverride || r.brand,
    category:     category.toLowerCase(),
    source_file:  filename,
    last_updated: today,
  }));
}

module.exports = { parseWithAI };