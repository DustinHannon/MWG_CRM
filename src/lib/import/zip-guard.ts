import "server-only";
import { inflateRawSync } from "node:zlib";
import { ValidationError } from "@/lib/errors";

/**
 * Decompression-amplification (zip-bomb) guard for XLSX uploads.
 *
 * An `.xlsx` is a ZIP archive. ExcelJS/JSZip eagerly inflate every entry
 * into the heap with NO decompression-ratio or output-size cap, so a small,
 * highly-compressible upload (whitespace/zeros at the DEFLATE ~1000:1
 * ceiling) can inflate to multiple GB and OOM the serverless function. The
 * upload-boundary size checks only see the COMPRESSED bytes, and ExcelJS's
 * own row caps run only AFTER the workbook is fully loaded — so neither
 * bounds the load-time blow-up.
 *
 * This guard parses the ZIP central directory (cheap, no inflation) to find
 * each entry's compressed stream, then inflates that ACTUAL stream with a
 * hard total output budget. It deliberately does NOT trust the declared
 * uncompressed size in the headers (an attacker can forge it small); the
 * `maxOutputLength` cap on the real inflate is what makes the bound sound —
 * inflation aborts at the cap instead of running to the full bomb size.
 *
 * Posture: it only ever REJECTS a proven-oversized file. Any parse quirk
 * (ZIP64, unknown compression method, truncation, a corrupt stream) FAILS
 * OPEN — control falls through to ExcelJS, which surfaces the real error —
 * so a legitimate workbook is never rejected by a parser edge case.
 */

// 200 MB of decompressed output. A legitimate 10k–50k-row import inflates to
// well under this; a bomb blows past it almost immediately and is aborted.
export const MAX_XLSX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;

const EOCD_SIG = 0x06054b50; // End of Central Directory record
const CDH_SIG = 0x02014b50; // Central Directory file Header
const LFH_SIG = 0x04034b50; // Local File Header

/** Locate the End-of-Central-Directory record (scans the trailing window). */
function findEocd(buf: Buffer): number {
  // EOCD is 22 bytes + an optional comment up to 0xffff.
  const minPos = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Inflate a single ZIP entry's stream and return its decompressed byte
 * length, capped at `budget`. Returns null when the entry can't be
 * evaluated (fail-open). Throws a ValidationError when the entry alone
 * exceeds the budget (a bomb).
 */
function inflatedEntrySize(
  buf: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
  budget: number,
): number | null {
  if (localOffset + 30 > buf.length) return null;
  if (buf.readUInt32LE(localOffset) !== LFH_SIG) return null;
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buf.length) return null;

  // Stored (uncompressed) entries can't amplify — output == input.
  if (method === 0) return compressedSize;

  // Deflate. ZIP uses raw deflate (no zlib/gzip wrapper). maxOutputLength
  // aborts the inflate the moment output would exceed the remaining budget.
  if (method === 8) {
    const slice = buf.subarray(dataStart, dataEnd);
    try {
      const out = inflateRawSync(slice, {
        maxOutputLength: Math.max(1, budget),
      });
      return out.length;
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
        throw new ValidationError(
          "This spreadsheet decompresses to an unexpectedly large size and was rejected.",
        );
      }
      return null; // corrupt/other stream -> fail open (ExcelJS will error)
    }
  }

  return null; // unknown compression method -> fail open
}

/**
 * Throw a ValidationError if `bytes` is a ZIP whose entries inflate beyond
 * MAX_XLSX_DECOMPRESSED_BYTES. Call this BEFORE handing the buffer to
 * ExcelJS's `xlsx.load()`.
 */
export function assertXlsxWithinDecompressionBudget(bytes: Uint8Array): void {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    const eocd = findEocd(buf);
    if (eocd < 0) return; // not a parseable ZIP -> fail open
    const entryCount = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);
    if (offset === 0xffffffff) return; // ZIP64 -> fail open

    let total = 0;
    for (let i = 0; i < entryCount; i++) {
      if (offset + 46 > buf.length) return; // truncated -> fail open
      if (buf.readUInt32LE(offset) !== CDH_SIG) return; // not a CDH -> fail open
      const method = buf.readUInt16LE(offset + 10);
      const compressedSize = buf.readUInt32LE(offset + 20);
      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      const localOffset = buf.readUInt32LE(offset + 42);
      if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        return; // ZIP64 -> fail open
      }

      const size = inflatedEntrySize(
        buf,
        localOffset,
        method,
        compressedSize,
        MAX_XLSX_DECOMPRESSED_BYTES - total,
      );
      if (size === null) return; // can't evaluate this entry -> fail open
      total += size;
      if (total > MAX_XLSX_DECOMPRESSED_BYTES) {
        throw new ValidationError(
          "This spreadsheet decompresses to an unexpectedly large size and was rejected.",
        );
      }

      offset += 46 + nameLen + extraLen + commentLen;
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    return; // any parse quirk -> fail open
  }
}
