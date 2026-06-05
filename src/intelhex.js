/**
 * Intel HEX file format parser.
 *
 * Supports records of type 0x00 (data), 0x01 (EOF), 0x02 (ext segment addr),
 * 0x04 (ext linear addr), and 0x05 (start linear addr).
 *
 * Ported from nordicsemi/dfu/intelhex/__init__.py and nordicsemi/dfu/nrfhex.py
 */

// ---- Error classes -------------------------------------------------------

export class HexError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'HexError';
  }
}

export class HexRecordError extends HexError {
  constructor(msg) {
    super(msg);
    this.name = 'HexRecordError';
  }
}

export class HexChecksumError extends HexRecordError {
  constructor(msg) {
    super(msg);
    this.name = 'HexChecksumError';
  }
}

// ---- IntelHex parser -----------------------------------------------------

/**
 * Parse an Intel HEX string into a map of address → byte value.
 *
 * @param {string} hexData - Entire .hex file content as a string
 * @returns {Object} An object with:
 *   - buf: {Map<number, number>} address→byte
 *   - startAddr: {{EIP?: number, CS?: number, IP?: number}|null}
 */
export function parseHex(hexData) {
  const buf = new Map();
  let startAddr = null;
  let extendedAddress = 0; // For record type 0x04 (upper 16 bits × 65536)
  let segmentAddress = 0;  // For record type 0x02 (upper 16 bits × 16)

  const lines = hexData.split(/\r?\n/);

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo].trim();
    if (!line) continue;

    if (line[0] !== ':') {
      throw new HexRecordError(`Line ${lineNo + 1}: missing ':' prefix`);
    }

    const hexStr = line.slice(1);
    if (hexStr.length < 8 || hexStr.length % 2 !== 0) {
      throw new HexRecordError(`Line ${lineNo + 1}: invalid hex string length`);
    }

    const bytes = hexToBytes(hexStr);
    const reclen = bytes[0];
    const addr = (bytes[1] << 8) | bytes[2];
    const rectype = bytes[3];

    // Minimum: reclen(1) + addr(2) + rectype(1) + checksum(1) = 5 bytes
    if (bytes.length !== reclen + 5) {
      throw new HexRecordError(
        `Line ${lineNo + 1}: record length mismatch (declared ${reclen}, actual ${bytes.length - 5})`
      );
    }

    // Checksum: sum of all bytes must be 0 (mod 256)
    const sum = bytes.reduce((s, b) => s + b, 0) & 0xff;
    if (sum !== 0) {
      throw new HexChecksumError(
        `Line ${lineNo + 1}: checksum error (computed ${sum.toString(16)}, expected 0)`
      );
    }

    const data = bytes.slice(4, 4 + reclen);

    switch (rectype) {
      case 0x00: {
        // Data record
        const baseAddress = extendedAddress + segmentAddress;
        const fileAddr = baseAddress + addr;
        for (let i = 0; i < data.length; i++) {
          const a = fileAddr + i;
          // Keep first occurrence (no overlap check — last wins in .hex is normal)
          buf.set(a, data[i]);
        }
        break;
      }

      case 0x01:
        // End of file — stop parsing
        return { buf, startAddr };

      case 0x02:
        // Extended Segment Address Record
        if (reclen !== 2 || addr !== 0) {
          throw new HexRecordError(
            `Line ${lineNo + 1}: invalid extended segment address record`
          );
        }
        segmentAddress = ((data[0] << 8) | data[1]) * 16;
        extendedAddress = 0;
        break;

      case 0x04:
        // Extended Linear Address Record
        if (reclen !== 2 || addr !== 0) {
          throw new HexRecordError(
            `Line ${lineNo + 1}: invalid extended linear address record`
          );
        }
        extendedAddress = ((data[0] << 8) | data[1]) * 65536;
        segmentAddress = 0;
        break;

      case 0x05:
        // Start Linear Address Record (EIP)
        if (reclen !== 4 || addr !== 0) {
          throw new HexRecordError(
            `Line ${lineNo + 1}: invalid start linear address record`
          );
        }
        startAddr = {
          EIP: (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3],
        };
        break;

      case 0x03:
        // Start Segment Address Record (CS:IP)
        if (reclen !== 4 || addr !== 0) {
          throw new HexRecordError(
            `Line ${lineNo + 1}: invalid start segment address record`
          );
        }
        startAddr = {
          CS: (data[0] << 8) | data[1],
          IP: (data[2] << 8) | data[3],
        };
        break;

      default:
        // Unknown record type — skip per specification
        break;
    }
  }

  // If no EOF record was found, return what we have
  return { buf, startAddr };
}

/**
 * Convert a hex string to a Uint8Array.
 * @param {string} hexStr
 * @returns {Uint8Array}
 */
export function hexToBytes(hexStr) {
  const len = hexStr.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hexStr.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Determine file format from filename.
 * @param {string} filename
 * @returns {'hex'|'bin'}
 */
export function detectFileFormat(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'hex' || ext === 'ihx') return 'hex';
  if (ext === 'bin') return 'bin';
  // Default: try to detect from content
  return 'bin';
}

// ---- nRFHex - extract binary for DFU ------------------------------------

/**
 * UICR region start address.
 */
const UICR_START = 0x10000000;

/**
 * MBR end addresses for known SoftDevice variants.
 */
const MBR_END = {
  s1x0: 0x1000,
  s132: 0x3000,
};

/**
 * Magic number for identifying SoftDevice info structure.
 */
const INFO_STRUCT_MAGIC = 0x51b1e5db;

const INFO_BASE = 0x00003000;
const INFO_OFFSET = 0x1000;
const MAGIC_OFFSET = 0x004;

/**
 * Convert parsed HEX data into a flat Uint8Array suitable for DFU.
 *
 * This mirrors nRFHex.tobinfile() behaviour:
 *   - Removes UICR region (≥ 0x10000000)
 *   - Detects MBR offset from SoftDevice info structure
 *   - Extracts from minaddr() to maxaddr(), word-aligned
 *
 * @param {Map<number, number>} buf - Address→byte map from parseHex()
 * @returns {Uint8Array} The contiguous binary image
 */
export function extractBinaryFromHex(buf) {
  if (buf.size === 0) return new Uint8Array(0);

  // Remove UICR addresses
  for (const addr of buf.keys()) {
    if (addr >= UICR_START) {
      buf.delete(addr);
    }
  }

  if (buf.size === 0) return new Uint8Array(0);

  const addrs = Array.from(buf.keys()).sort((a, b) => a - b);
  const minAddr = findMinAddr(buf, addrs);
  const maxAddr = addrs[addrs.length - 1];

  const rawSize = maxAddr - minAddr + 1;
  // Round up to nearest word (4 bytes)
  const wordSize = 4;
  const paddedSize = Math.ceil(rawSize / wordSize) * wordSize;

  const result = new Uint8Array(paddedSize);
  for (let i = 0; i < paddedSize; i++) {
    const addr = minAddr + i;
    result[i] = buf.has(addr) ? buf.get(addr) : 0xff; // padding
  }

  return result;
}

/**
 * Extract a specific address range from the parsed HEX buffer into a flat binary.
 * The range is word-aligned (padded with 0xFF).
 *
 * @param {Map<number, number>} buf - Address→byte map from parseHex()
 * @param {number} startAddr - Start address (inclusive)
 * @param {number} endAddr - End address (inclusive)
 * @returns {Uint8Array}
 */
export function extractRegionBinary(buf, startAddr, endAddr) {
  const rawSize = endAddr - startAddr + 1;
  if (rawSize <= 0) return new Uint8Array(0);
  const wordSize = 4;
  const paddedSize = Math.ceil(rawSize / wordSize) * wordSize;
  const result = new Uint8Array(paddedSize);
  for (let i = 0; i < paddedSize; i++) {
    const addr = startAddr + i;
    result[i] = buf.has(addr) ? buf.get(addr) : 0xff;
  }
  return result;
}

/**
 * Find the minimum address for binary extraction, skipping the MBR region.
 *
 * @param {Map<number, number>} buf
 * @param {number[]} sortedAddrs - Sorted array of addresses
 * @returns {number}
 */
function findMinAddr(buf, sortedAddrs) {
  const sdVariant = detectSoftDevice(buf, sortedAddrs);
  const mbrEnd = MBR_END[sdVariant] || 0x1000;

  // Find first address >= mbrEnd
  for (const addr of sortedAddrs) {
    if (addr >= mbrEnd) return addr;
  }
  return sortedAddrs[0];
}

/**
 * Detect SoftDevice variant by looking for magic numbers in the info struct area.
 *
 * @param {Map<number, number>} buf
 * @param {number[]} sortedAddrs
 * @returns {'s1x0'|'s132'|'unknown'}
 */
function detectSoftDevice(buf, sortedAddrs) {
  // s1x0 check
  const s1x0Addr = INFO_BASE + MAGIC_OFFSET;
  if (hasMagicNumber(buf, s1x0Addr)) return 's1x0';

  // s132 check (offset by INFO_OFFSET, up to 4 attempts)
  for (let i = 0; i < 4; i++) {
    const candidate = INFO_BASE + MAGIC_OFFSET + i * INFO_OFFSET;
    if (hasMagicNumber(buf, candidate)) return 's132';
  }

  return 'unknown';
}

/**
 * Check if a 4-byte magic number exists at the given address.
 * @param {Map<number, number>} buf
 * @param {number} addr
 * @returns {boolean}
 */
function hasMagicNumber(buf, addr) {
  if (!buf.has(addr) || !buf.has(addr + 1) || !buf.has(addr + 2) || !buf.has(addr + 3)) {
    return false;
  }
  const val =
    (buf.get(addr) << 0) |
    (buf.get(addr + 1) << 8) |
    (buf.get(addr + 2) << 16) |
    (buf.get(addr + 3) << 24);
  return (val >>> 0) === INFO_STRUCT_MAGIC;
}

/**
 * Load firmware from a file path or Uint8Array, auto-detecting format.
 *
 * For Node.js usage with file paths; for browser usage, read the file
 * as text (hex) or binary (bin) first, then pass content with format hint.
 *
 * @param {string|Uint8Array} source - File path (Node) or raw bytes (browser)
 * @param {'hex'|'bin'} [format] - Explicit format override
 * @returns {Promise<Uint8Array>} Flat binary image ready for DFU
 */
export async function loadFirmware(source, format) {
  if (typeof source === 'string') {
    // Node.js: source is a file path
    const fs = await import('fs');
    const detectedFormat = format || detectFileFormat(source);

    if (detectedFormat === 'hex') {
      const hexData = fs.readFileSync(source, 'utf-8');
      const { buf } = parseHex(hexData);
      return extractBinaryFromHex(buf);
    } else {
      return fs.readFileSync(source);
    }
  } else {
    // Browser or in-memory: source is a Uint8Array
    if (format === 'hex') {
      const hexStr = new TextDecoder().decode(source);
      const { buf } = parseHex(hexStr);
      return extractBinaryFromHex(buf);
    } else {
      return source;
    }
  }
}
