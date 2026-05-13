/**
 * Streaming CSV export.
 *
 * The Excel variant in `./stream-excel` is the heavyweight path
 * (compression, multi-sheet workbooks, number formatting). For
 * downstream consumption that's just a flat tabular file — pivot
 * tables, scripts, BI ingestion — CSV is faster to produce and
 * smaller on the wire. Same generator-driven memory-bounded shape
 * as the Excel variant.
 *
 * Encoding: UTF-8 with a BOM. Excel on Windows requires the BOM to
 * interpret non-ASCII columns correctly; consumers reading via
 * `csv-parse` / `pandas` will strip the BOM transparently.
 */

import type { ExportColumn } from "./stream-excel";

export type { ExportColumn };

export interface StreamCsvOptions<T> {
  rows: AsyncGenerator<T[]> | AsyncIterable<T[]>;
  columns: readonly ExportColumn[];
  /** See `stream-excel`. */
  mapRow?: (row: T) => Record<string, unknown>;
}

const BOM = "﻿";

/**
 * Format a single CSV cell. RFC 4180 escaping: wrap in double quotes
 * when the value contains a delimiter, quote, or newline; double-up
 * embedded quotes. `null` / `undefined` render as empty strings.
 * Dates render as ISO 8601 strings; everything else goes through
 * `String(...)`.
 */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (value instanceof Date) {
    s = value.toISOString();
  } else if (typeof value === "object") {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatRow(values: readonly unknown[]): string {
  return values.map(formatCell).join(",") + "\r\n";
}

/** Build a streaming CSV response body. */
export function streamCsv<T>(
  options: StreamCsvOptions<T>,
): ReadableStream<Uint8Array> {
  const { rows, columns, mapRow } = options;
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // BOM + header row.
        controller.enqueue(encoder.encode(BOM));
        controller.enqueue(
          encoder.encode(formatRow(columns.map((c) => c.header))),
        );

        for await (const batch of rows) {
          for (const row of batch) {
            const shaped = mapRow
              ? mapRow(row)
              : (row as unknown as Record<string, unknown>);
            const values = columns.map((c) => shaped[c.key]);
            controller.enqueue(encoder.encode(formatRow(values)));
          }
        }
        controller.close();
      } catch (err) {
        controller.error(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    },
  });
}

export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";
