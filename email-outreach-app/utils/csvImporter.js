const fs = require('fs');
const { parse } = require('csv-parse/sync');

async function importCsvFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true
  });
  return records;
}

module.exports = { importCsvFile };
