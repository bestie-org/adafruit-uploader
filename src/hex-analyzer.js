/**
 * nRF5x .hex file analyzer - detects firmware components and their boundaries.
 *
 * Analyzes a parsed Intel HEX buffer to determine what components are present:
 *   - SoftDevice (SD): detected via magic number 0x51B1E5DB at info structure
 *   - Bootloader (BL): detected via data in high flash addresses
 *   - Application (APP): everything else
 *
 * The SD info structure at 0x3000 contains:
 *   +0x000: flags/type  (always 0xFFFFFF2C)
 *   +0x004: magic       (0x51B1E5DB)
 *   +0x008: SD size     (uint32 LE, bytes)
 *   +0x00C: build/version ID (uint32 LE)
 *   +0x010: SD number   (uint32 LE: 132=S132, 140=S140, 312=S312)
 *
 * Reference: Adafruit_nRF52_nrfutil / nordicsemi/dfu/nrfhex.py
 */

import { parseHex } from './intelhex.js';

// ---- SoftDevice Info Structure -------------------------------------------

const INFO_BASE = 0x00003000;
const INFO_MAGIC_OFFSET = 0x004;
const INFO_STRUCT_MAGIC = 0x51B1E5DB;

// SD number at 0x3010 → { name, mcu }
const SD_NUMBER_MAP = {
  110: { name: 'S110', mcu: 52832 },
  113: { name: 'S113', mcu: 52832 },
  120: { name: 'S120', mcu: 52832 },
  130: { name: 'S130', mcu: 52832 },
  132: { name: 'S132', mcu: 52832 },
  140: { name: 'S140', mcu: 52840 },
  210: { name: 'S210', mcu: 52832 },
  212: { name: 'S212', mcu: 52832 },
  312: { name: 'S312', mcu: 52833 },
  330: { name: 'S330', mcu: 52840 },
  332: { name: 'S332', mcu: 52840 },
  340: { name: 'S340', mcu: 52840 },
};

// Version/build IDs at 0x300C → descriptive version strings
const SD_BUILD_MAP = {
  // S140 builds
  0x00B6: '6.1.1',
  0x0100: '7.2.0',
  0x0123: '7.3.0',
  // S132 builds
  0x00B7: '6.1.1',
  0x0124: '7.3.0',
  // S332 builds
  0x00CF: '7.0.1',
  // S340 builds
  0x00CE: '7.0.1',
};

const MBR_SIZE = 0x1000;

// ---- Analysis result class -----------------------------------------------

/**
 * Result of analyzing a .hex file.
 */
export class HexAnalysis {
  constructor() {
    /** @type {'application'|'softdevice'|'bootloader'|'sd_bl'|'sd_app'|'sd_bl_app'|'unknown'} */
    this.type = 'unknown';
    /** @type {number} SoftDevice number (132, 140, 312), or 0 if not present */
    this.sdFirmwareId = 0;
    /** @type {string} SoftDevice name like "S140", or '' */
    this.sdName = '';
    /** @type {number} SoftDevice version/build ID, or 0 */
    this.sdVersion = 0;
    /** @type {string} SoftDevice version string like "7.3.0", or '' */
    this.sdVersionStr = '';
    /** @type {number} SoftDevice size in bytes (total, includes MBR), or 0 if no SD */
    this.sdSize = 0;
    /** @type {number} Bootloader offset start address, or 0 if no BL */
    this.blStart = 0;
    /** @type {number} Bootloader size in bytes, or 0 if no BL */
    this.blSize = 0;
    /** @type {number} Application start address (relative to 0), or 0 if no APP */
    this.appStart = 0;
    /** @type {number} Application size in bytes, or 0 if no APP */
    this.appSize = 0;
    /** @type {number} Minimum address after removing UICR */
    this.minAddr = 0;
    /** @type {number} Maximum address */
    this.maxAddr = 0;
    /** @type {number} Detected MCU model: 52832, 52833, or 52840 */
    this.mcu = 52840;
    /** @type {boolean} True if the UICR region was found and removed */
    this.hasUicr = false;
    /** @type {Map<number, number>} The original parsed buffer (after UICR removal) */
    this.buf = null;
    /** @type {Array<{start: number, end: number, label: string}>} Address regions found */
    this.regions = [];
    /** @type {number} Total binary size for DFU (padded to word) */
    this.totalSize = 0;
  }

  /** Human-readable summary */
  toString() {
    const parts = [];
    parts.push(`MCU: nRF${this.mcu}`);
    if (this.sdFirmwareId) {
      const ver = this.sdVersionStr ? ` v${this.sdVersionStr}` : (this.sdVersion ? ` build=0x${this.sdVersion.toString(16)}` : '');
      parts.push(`SD: ${this.sdName}${ver}`);
    }
    if (this.blSize) {
      parts.push(`BL: ${this.blSize} bytes at 0x${this.blStart.toString(16)}`);
    }
    if (this.appSize) {
      parts.push(`APP: ${this.appSize} bytes at 0x${this.appStart.toString(16)}`);
    }
    parts.push(`Total: ${this.totalSize} bytes`);
    parts.push(`Type: ${this.type}`);
    return parts.join(' | ');
  }

  /**
   * Get merged regions for display — adjacent regions with the same label
   * are collapsed into one (e.g. two separate Bootloader chunks → one).
   * @returns {Array<{start: number, end: number, label: string}>}
   */
  getMergedRegions() {
    if (this.regions.length === 0) return [];
    const merged = [{ ...this.regions[0] }];
    for (let i = 1; i < this.regions.length; i++) {
      const prev = merged[merged.length - 1];
      const cur = this.regions[i];
      // Merge if same label and adjacent or overlapping
      if (cur.label === prev.label && cur.start <= prev.end + 1) {
        prev.end = Math.max(prev.end, cur.end);
      } else {
        merged.push({ ...cur });
      }
    }
    return merged;
  }
}

// ---- Detection helpers ---------------------------------------------------

/**
 * Read a uint32 LE value from the buffer at a given address.
 * @param {Map<number, number>} buf
 * @param {number} addr
 * @returns {number}
 */
function readUint32(buf, addr) {
  if (!buf.has(addr) || !buf.has(addr + 1) || !buf.has(addr + 2) || !buf.has(addr + 3)) return 0;
  return (buf.get(addr) |
          (buf.get(addr + 1) << 8) |
          (buf.get(addr + 2) << 16) |
          (buf.get(addr + 3) << 24)) >>> 0;
}

/**
 * Detect SoftDevice info structure at 0x3000.
 *
 * @param {Map<number, number>} buf
 * @returns {{ sdNumber: number, sdSize: number, buildId: number }|null}
 */
function detectSoftDeviceInfo(buf) {
  const magic = readUint32(buf, INFO_BASE + INFO_MAGIC_OFFSET);
  if (magic !== INFO_STRUCT_MAGIC) return null;

  const sdSize = readUint32(buf, INFO_BASE + 0x008);
  // Build/version ID at 0x300C: lower 2 bytes, upper 2 bytes may be padding
  const buildIdRaw = readUint32(buf, INFO_BASE + 0x00C);
  const buildId = buildIdRaw & 0xFFFF;
  const sdNumber = readUint32(buf, INFO_BASE + 0x010);

  return { sdNumber, sdSize, buildId };
}

/**
 * Find contiguous data regions in the parsed buffer (after UICR removal).
 *
 * @param {Map<number, number>} buf
 * @returns {Array<{start: number, end: number}>}
 */
function findContiguousRegions(buf) {
  const addrs = Array.from(buf.keys()).sort((a, b) => a - b);
  if (addrs.length === 0) return [];

  const regions = [];
  let start = addrs[0];
  let prev = addrs[0];

  for (let i = 1; i < addrs.length; i++) {
    const addr = addrs[i];
    if (addr - prev > 1) {
      regions.push({ start, end: prev });
      start = addr;
    }
    prev = addr;
  }
  regions.push({ start, end: prev });

  return regions;
}

/**
 * Detect the MCU model from address ranges and SD info.
 * nRF52840 = 1MB flash, nRF52840 = 512KB flash, nRF52832 = 256KB or 512KB flash.
 *
 * @param {Map<number, number>} buf
 * @param {number} [sdNumber=0] - SoftDevice number if SD detected
 * @returns {52832|52833|52840}
 */
function detectMcu(buf, sdNumber = 0) {
  // If we have an SD number, use it first
  if (sdNumber && SD_NUMBER_MAP[sdNumber]) {
    return SD_NUMBER_MAP[sdNumber].mcu;
  }

  // Fall back to address range analysis
  let maxAddr = 0;
  let minAddr = 0xFFFFFFFF;
  for (const addr of buf.keys()) {
    if (addr > maxAddr && addr < 0x10000000) maxAddr = addr;
    if (addr < minAddr && addr >= MBR_SIZE) minAddr = addr;
  }

  if (maxAddr >= 0xF8000) return 52840;
  if (maxAddr >= 0x70000) return 52833;
  if (maxAddr >= 0x40000) return 52832;

  // For app-only hex files where maxAddr < 0x40000, use the app start
  // address as a heuristic:
  //   - App at 0x26000 → typical for nRF52832 (SD ends at 0x27000-SDsize)
  //   - App at 0x27000 → typical for nRF52840 (S140 v7.x SD ends at 0x27000)
  //   - App at 0x20000 or 0x1XXXX → could be 52832 with older SD
  //   - App at 0x19000 → nRF52832 with S132 v6
  if (minAddr !== 0xFFFFFFFF) {
    if (minAddr === 0x26000) return 52832; // S132 app start
    if (minAddr === 0x19000) return 52832; // S132 v6 app start
    if (minAddr === 0x27000) return 52840; // S140 app start
    if (minAddr === 0x20000) return 52832; // other SD app start
  }

  // Too low to distinguish — default to 52840 (most common with Adafruit Feather)
  return 52840;
}

// ---- Main analysis function ----------------------------------------------

/**
 * Analyze a parsed Intel HEX buffer to detect firmware components.
 *
 * @param {Map<number, number>} buf - Address→byte map from parseHex()
 * @returns {HexAnalysis}
 */
export function analyzeHex(buf) {
  const analysis = new HexAnalysis();
  analysis.buf = new Map(buf); // copy

  // 1. Remove UICR region (addresses >= 0x10000000)
  for (const addr of analysis.buf.keys()) {
    if (addr >= 0x10000000) {
      analysis.buf.delete(addr);
      analysis.hasUicr = true;
    }
  }

  if (analysis.buf.size === 0) {
    return analysis;
  }

  // 2. Detect SoftDevice
  const sdInfo = detectSoftDeviceInfo(analysis.buf);
  let sdNumber = 0;
  if (sdInfo) {
    sdNumber = sdInfo.sdNumber;
    analysis.sdFirmwareId = sdInfo.sdNumber;
    analysis.sdVersion = sdInfo.buildId;
    analysis.sdVersionStr = SD_BUILD_MAP[sdInfo.buildId] || '';
    const sdEntry = SD_NUMBER_MAP[sdNumber];
    analysis.sdName = sdEntry ? sdEntry.name : ('SD #' + sdNumber);

    // SD size from info struct is absolute (from flash base to SD end).
    // For DFU, the size sent to the bootloader is relative to MBR end (0x1000).
    analysis.sdSize = sdInfo.sdSize - MBR_SIZE;
  }

  // 3. Detect MCU
  analysis.mcu = detectMcu(analysis.buf, sdNumber);

  // 4. Find contiguous data regions
  const regions = findContiguousRegions(analysis.buf);
  analysis.regions = regions.map(r => ({ ...r, label: 'unknown' }));

  // 5. Classify regions
  const flashSize = analysis.mcu === 52832 ? 0x40000 : (analysis.mcu === 52833 ? 0x80000 : 0x100000);

  // Bootloader threshold: found in the last portion of flash.
  // nRF52840: bootloader is typically at 0xF8000 or above.
  // nRF52833: bootloader is typically at 0x78000 or above.
  // nRF52832: bootloader is typically at 0x38000 or above.
  const blThreshold = analysis.mcu === 52840 ? 0xE0000 :
                      analysis.mcu === 52833 ? 0x70000 :
                      0x38000;

  // Determine SD end address: either from the SD info size, or from the start
  // of the next region after the SD region.
  let sdEndAddr = 0;
  if (sdInfo) {
    sdEndAddr = sdInfo.sdSize; // absolute address
  }

  for (const r of analysis.regions) {
    // Region in the MBR range (0x0000-0x0FFF) → MBR (check first, before SoftDevice)
    if (r.start < MBR_SIZE) {
      r.label = 'MBR';
    }
    // Region at low addresses (< 0x8000) → SoftDevice (if SD detected)
    else if (r.start < 0x8000 && sdInfo) {
      r.label = 'SoftDevice';
    }
    // Region at or above bootloader threshold → Bootloader
    else if (r.start >= blThreshold) {
      r.label = 'Bootloader';
    }
    // Region that starts at the known SD end address → Application
    else if (sdEndAddr > 0 && r.start >= sdEndAddr) {
      r.label = 'Application';
    }
    // Region that starts after a gap from the previous → Application
    else {
      r.label = 'Application';
    }
  }

  // 6. Determine component addresses and sizes
  let minAddrVal = 0xFFFFFFFF, maxAddrVal = 0;
  for (const addr of analysis.buf.keys()) {
    if (addr < minAddrVal) minAddrVal = addr;
    if (addr > maxAddrVal) maxAddrVal = addr;
  }
  analysis.minAddr = minAddrVal;
  analysis.maxAddr = maxAddrVal;

  let sdStart = 0xFFFFFFFF, sdEnd = 0;
  let blStart = 0xFFFFFFFF, blEnd = 0;
  let appStart = 0xFFFFFFFF, appEnd = 0;

  for (const r of analysis.regions) {
    if (r.label === 'SoftDevice' || r.label === 'MBR') {
      if (r.start < sdStart) sdStart = r.start;
      if (r.end > sdEnd) sdEnd = r.end;
    } else if (r.label === 'Bootloader') {
      if (r.start < blStart) blStart = r.start;
      if (r.end > blEnd) blEnd = r.end;
    } else if (r.label === 'Application') {
      if (r.start < appStart) appStart = r.start;
      if (r.end > appEnd) appEnd = r.end;
    }
  }

  if (blStart !== 0xFFFFFFFF) {
    analysis.blStart = blStart;
    analysis.blSize = blEnd - blStart + 1;
  }

  if (appStart !== 0xFFFFFFFF) {
    analysis.appStart = appStart;
    analysis.appSize = appEnd - appStart + 1;
  }

  // 7. Determine total binary size (from min to max, rounded to word)
  const rawSize = analysis.maxAddr - analysis.minAddr + 1;
  const wordSize = 4;
  analysis.totalSize = Math.ceil(rawSize / wordSize) * wordSize;

  // 8. Classify the overall hex type
  const hasSD = !!sdInfo;
  const hasBL = blStart !== 0xFFFFFFFF;
  const hasAPP = appStart !== 0xFFFFFFFF;

  if (hasSD && hasBL && hasAPP) analysis.type = 'sd_bl_app';
  else if (hasSD && hasBL) analysis.type = 'sd_bl';
  else if (hasSD && hasAPP) analysis.type = 'sd_app';
  else if (hasSD) analysis.type = 'softdevice';
  else if (hasBL) analysis.type = 'bootloader';
  else if (hasAPP) analysis.type = 'application';
  else analysis.type = 'unknown';

  return analysis;
}

/**
 * Convenience: analyze a .hex file from a string.
 *
 * @param {string} hexData - The .hex file content
 * @returns {HexAnalysis}
 */
export function analyzeHexString(hexData) {
  const { buf } = parseHex(hexData);
  return analyzeHex(buf);
}
