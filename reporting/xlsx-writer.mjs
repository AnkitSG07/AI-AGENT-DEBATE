// Production server export writer; user strings are always literal cell values.
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { MIME_XLSX, requireValue } from './schema.mjs';

export async function writeHistoryWorkbook({ rows, exportId, createdAtMs, selection }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Smart Handicrafts Operator Hub';
  workbook.created = new Date(createdAtMs); workbook.modified = new Date(createdAtMs);
  workbook.title = 'Smart Handicrafts call and operator history';
  for (const kind of ['calls', 'activity']) {
    const items = rows.filter(row => row.kind === kind);
    if (!items.length) continue;
    const isCalls = kind === 'calls';
    const headers = isCalls ? ['Call ID', 'Direction', 'Customer', 'Phone', 'Started (UTC)', 'Connected (UTC)', 'Ended (UTC)', 'Outcome', 'Operator', 'Duration (s)', 'Transfers', 'Device ID'] :
      ['Event ID', 'Call ID', 'Event type', 'Occurred (UTC)', 'Operator', 'Status', 'Summary'];
    const widths = isCalls ? [34, 14, 28, 22, 24, 24, 24, 16, 24, 15, 13, 34] : [34, 34, 24, 24, 24, 18, 60];
    const sheet = workbook.addWorksheet(isCalls ? 'Calls' : 'Activity', { views: [{ state: 'frozen', ySplit: 6, showGridLines: false }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    sheet.columns = widths.map(width => ({ width }));
    sheet.mergeCells(1, 1, 1, headers.length);
    const title = sheet.getCell(1, 1); title.value = `Smart Handicrafts | ${isCalls ? 'Call history' : 'Operator activity'}`;
    title.font = { name: 'Calibri', size: 19, bold: true, color: { argb: 'FFFFFFFF' } };
    title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F5C4A' } }; sheet.getRow(1).height = 34;
    sheet.getRow(2).values = ['Export ID', exportId, 'Records', items.length];
    sheet.getRow(3).values = ['From (UTC)', new Date(selection.fromMs), 'Before (UTC)', new Date(selection.beforeMs)];
    sheet.getCell('B3').numFmt = 'dd-mmm-yyyy hh:mm:ss'; sheet.getCell('D3').numFmt = 'dd-mmm-yyyy hh:mm:ss';
    sheet.mergeCells(4, 1, 4, headers.length);
    sheet.getCell(4, 1).value = 'Source: finalized Operator Hub report records. All times are UTC. Device registrations and live call state are excluded.';
    sheet.getCell(4, 1).font = { name: 'Calibri', size: 10, color: { argb: 'FF51636A' } }; sheet.getRow(4).height = 28;
    const values = items.map(({ data }) => isCalls ? [data.callId, data.direction, data.customerName, data.customerPhone,
      new Date(data.startedAtMs), data.connectedAtMs === null ? null : new Date(data.connectedAtMs), new Date(data.endedAtMs), data.outcome,
      data.operatorLabel, data.durationSeconds, data.transferCount, data.operatorDeviceId] :
      [data.eventId, data.callId, data.eventType, new Date(data.occurredAtMs), data.operatorLabel, data.status, data.summary]);
    sheet.addTable({ name: isCalls ? 'CallHistory' : 'OperatorActivity', ref: 'A6', headerRow: true, totalsRow: false,
      style: { theme: 'TableStyleMedium4', showRowStripes: true }, columns: headers.map(name => ({ name })), rows: values });
    sheet.getRow(6).height = 28;
    for (let row = 7; row < 7 + values.length; row++) {
      sheet.getRow(row).height = 34;
      sheet.getRow(row).font = { name: 'Calibri', size: 11 };
      sheet.getRow(row).alignment = { vertical: 'middle', wrapText: true };
      for (const col of isCalls ? [5, 6, 7] : [4]) sheet.getCell(row, col).numFmt = 'dd-mmm-yyyy hh:mm:ss';
      if (isCalls) { sheet.getCell(row, 4).numFmt = '@'; sheet.getCell(row, 10).numFmt = '#,##0'; sheet.getCell(row, 11).numFmt = '#,##0'; }
    }
    sheet.pageSetup.printTitlesRow = '1:6';
  }
  // ExcelJS defaults ZIP entry timestamps to the wall clock. Normalize them to
  // the immutable export timestamp so a restart can regenerate identical bytes
  // for the saved export plan without a second archive or a changed hash.
  const archive = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const stableDate = new Date(Math.max(createdAtMs, Date.UTC(1980, 0, 1)));
  for (const entry of Object.values(archive.files)) entry.date = stableDate;
  const bytes = Buffer.from(await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
  requireValue(bytes.length > 0 && bytes.length <= 10 * 1024 * 1024, 'EXPORT_LIMIT', 'The workbook is too large; export a smaller batch.', 413);
  return bytes;
}

export async function zipDownload(bundle) {
  const zip = new JSZip();
  const date = new Date(bundle.batch.createdAtMs);
  zip.file(bundle.xlsx.name, bundle.xlsx.bytes, { date });
  zip.file(bundle.manifest.name, bundle.manifest.bytes, { date });
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
}
export { MIME_XLSX };
