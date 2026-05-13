import ExcelJS from "exceljs";
import { PassThrough, Readable } from "node:stream";

/**
 * Streaming .xlsx export.
 *
 * Wraps ExcelJS's `stream.xlsx.WorkbookWriter` so callers can hand a
 * row generator and get a web `ReadableStream` back — ready to drop
 * into `new Response(stream, { headers })` in a Next.js route
 * handler.
 *
 * Memory bound: WorkbookWriter commits rows page-at-a-time to the
 * underlying zip stream, so peak memory stays proportional to the
 * batch size returned by the row generator (typically one page),
 * not the full result set. The historic in-memory export
 * (`marketing/reports/email/export/route.ts`) buffers the entire
 * workbook in a Buffer before responding; this stream variant lets
 * exports with 10k+ rows ship without OOM risk.
 *
 * Column definitions match the existing ExcelJS column shape so
 * call sites can lift their existing column arrays without
 * restructuring.
 */

export interface ExportColumn {
  header: string;
  key: string;
  width?: number;
  /** Optional ExcelJS number format string, e.g. "0.0%" or "yyyy-mm-dd hh:mm". */
  numFmt?: string;
}

export interface StreamExcelOptions<T> {
  /** Row generator. Each yielded array is a batch (typically one page). */
  rows: AsyncGenerator<T[]> | AsyncIterable<T[]>;
  /** Column definitions in display order. Must match `key` lookup on the row objects. */
  columns: readonly ExportColumn[];
  /** Worksheet name. Default `"Sheet1"`. */
  sheetName?: string;
  /** Workbook creator metadata. Default `"MWG CRM"`. */
  creator?: string;
  /**
   * Optional row mapper. Defaults to identity — rows must already be
   * plain objects keyed by `columns[].key`. Pass a mapper when the
   * generator yields entity rows that need shaping (e.g.,
   * `(lead) => ({ name: lead.name, status: lead.status, ... })`).
   */
  mapRow?: (row: T) => Record<string, unknown>;
}

/**
 * Build a streaming .xlsx response body. Returns a web
 * `ReadableStream` of `Uint8Array` chunks.
 *
 * Errors thrown by the row generator are surfaced by closing the
 * stream with an error — the consumer's `Response` will end with a
 * truncated body and the client download will fail visibly. That's
 * preferable to silently producing a corrupt .xlsx.
 */
export function streamExcel<T>(
  options: StreamExcelOptions<T>,
): ReadableStream<Uint8Array> {
  const {
    rows,
    columns,
    sheetName = "Sheet1",
    creator = "MWG CRM",
    mapRow,
  } = options;

  const pass = new PassThrough();

  // Kick off the writer asynchronously. We capture the promise so an
  // unhandled rejection doesn't escape — failures destroy the stream
  // which propagates to the web ReadableStream consumer.
  void (async () => {
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: pass,
      useStyles: false,
      useSharedStrings: false,
    });
    wb.creator = creator;
    wb.created = new Date();

    const ws = wb.addWorksheet(sheetName);
    ws.columns = columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width,
    }));
    for (const c of columns) {
      if (c.numFmt) {
        ws.getColumn(c.key).numFmt = c.numFmt;
      }
    }
    // Commit the header row so it lands in the zip stream up front.
    ws.getRow(1).commit();

    try {
      for await (const batch of rows) {
        for (const row of batch) {
          const shaped = mapRow ? mapRow(row) : (row as unknown as Record<string, unknown>);
          ws.addRow(shaped).commit();
        }
      }
      await ws.commit();
      await wb.commit();
    } catch (err) {
      // Surface the error to the consumer by destroying the stream;
      // the web side will reject in-flight reads.
      pass.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  // Node Readable → web ReadableStream. Available since Node 17;
  // Next.js 16 runs on Node 20+ so this is safe.
  return Readable.toWeb(pass) as ReadableStream<Uint8Array>;
}

/** Standard Content-Type for .xlsx responses. */
export const EXCEL_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
