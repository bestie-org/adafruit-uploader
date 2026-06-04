/**
 * Protocol unit tests — run with: node src/test-protocol.js
 *
 * These tests verify the core protocol primitives against known values
 * derived from the Python implementation.
 */

import { calcCrc16 } from './crc16.js';
import {
  int32ToBytes,
  int16ToBytes,
  slipPartsToFourBytes,
  slipEncodeEscChars,
  slipDecodeEscChars,
  toHexString,
} from './util.js';
import { HciPacket, DFU_INIT_PACKET, DFU_START_PACKET } from './dfu-transport-serial.js';
import { parseHex, extractBinaryFromHex } from './intelhex.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function assertHexEqual(actual, expected, label) {
  const aStr = Array.from(actual)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  const eStr = Array.from(expected)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  if (aStr === eStr) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`    expected: [${eStr}]`);
    console.error(`    actual:   [${aStr}]`);
    failed++;
  }
}

// ---- CRC16 tests ---------------------------------------------------------
console.log('\n--- CRC16 ---');

// Python: calc_crc16(b'\x01\x02\x03\x04', 0xffff) = 0x89c3
const crc1 = calcCrc16(new Uint8Array([1, 2, 3, 4]), 0xffff);
assert(crc1 === 0x89c3, `CRC16([1,2,3,4]) = 0x${crc1.toString(16)} (expected 0x89c3)`);

// Empty data
const crc2 = calcCrc16(new Uint8Array([]), 0xffff);
assert(crc2 === 0xffff, `CRC16([]) = 0x${crc2.toString(16)} (expected 0xffff)`);

// Single byte
const crc3 = calcCrc16(new Uint8Array([0x00]), 0xffff);
assert(typeof crc3 === 'number' && crc3 >= 0 && crc3 <= 0xffff, 'CRC16 result is 16-bit');

// ---- int32ToBytes tests --------------------------------------------------
console.log('\n--- int32ToBytes ---');

assertHexEqual(
  int32ToBytes(0x01020304),
  new Uint8Array([0x04, 0x03, 0x02, 0x01]),
  'int32ToBytes(0x01020304)'
);

assertHexEqual(
  int32ToBytes(0),
  new Uint8Array([0x00, 0x00, 0x00, 0x00]),
  'int32ToBytes(0)'
);

assertHexEqual(
  int32ToBytes(1),
  new Uint8Array([0x01, 0x00, 0x00, 0x00]),
  'int32ToBytes(1)'
);

assertHexEqual(
  int32ToBytes(0xffeeddcc),
  new Uint8Array([0xcc, 0xdd, 0xee, 0xff]),
  'int32ToBytes(0xffeeddcc)'
);

// ---- int16ToBytes tests --------------------------------------------------
console.log('\n--- int16ToBytes ---');

assertHexEqual(
  int16ToBytes(0x0102),
  new Uint8Array([0x02, 0x01]),
  'int16ToBytes(0x0102)'
);

assertHexEqual(
  int16ToBytes(0xff00),
  new Uint8Array([0x00, 0xff]),
  'int16ToBytes(0xff00)'
);

// ---- SLIP header tests ---------------------------------------------------
console.log('\n--- SLIP Header ---');

// seq=0, dip=1, rp=1, pktType=14, pktLen=4
// Python reference:
//   slip_parts_to_four_bytes(0, 1, 1, 14, 4)
//   → [0xc8, 0x4e, 0x00, 0xea]
// byte0: 0 | ((0+1)%8)<<3 | 1<<6 | 1<<7 = 0 | 8 | 64 | 128 = 0xC8
// byte1: 14 | (4 & 0xF)<<4 = 14 | 64 = 0x4E
// byte2: (4 & 0xFF0)>>4 = 0
// byte3: (~(0xC8+0x4E+0) + 1) & 0xFF = (~0x116 + 1) & 0xFF = 0xEA
const header = slipPartsToFourBytes(0, 1, 1, 14, 4);
assertHexEqual(
  header,
  new Uint8Array([0xc8, 0x4e, 0x00, 0xea]),
  'SLIP header seq=0 dip=1 rp=1 type=14 len=4'
);

// ---- SLIP encode/decode tests -------------------------------------------
console.log('\n--- SLIP Encode/Decode ---');

// No special chars
const plain = new Uint8Array([0x01, 0x02, 0x03]);
const encodedPlain = slipEncodeEscChars(plain);
assertHexEqual(encodedPlain, new Uint8Array([0x01, 0x02, 0x03]), 'SLIP encode plain data');

// 0xC0 → 0xDB 0xDC
const withC0 = new Uint8Array([0xc0]);
const encodedC0 = slipEncodeEscChars(withC0);
assertHexEqual(encodedC0, new Uint8Array([0xdb, 0xdc]), 'SLIP encode 0xC0');

// 0xDB → 0xDB 0xDD
const withDB = new Uint8Array([0xdb]);
const encodedDB = slipEncodeEscChars(withDB);
assertHexEqual(encodedDB, new Uint8Array([0xdb, 0xdd]), 'SLIP encode 0xDB');

// Decode round-trip
const decodedC0 = slipDecodeEscChars(Array.from(encodedC0));
assert(decodedC0[0] === 0xc0 && decodedC0.length === 1, 'SLIP decode 0xDBDC → 0xC0');

const decodedDB = slipDecodeEscChars(Array.from(encodedDB));
assert(decodedDB[0] === 0xdb && decodedDB.length === 1, 'SLIP decode 0xDBDD → 0xDB');

// Round-trip: mixed
const mixed = new Uint8Array([0x01, 0xc0, 0x02, 0xdb, 0x03]);
const encodedMixed = slipEncodeEscChars(mixed);
const decodedMixed = slipDecodeEscChars(Array.from(encodedMixed));
assert(
  decodedMixed.length === mixed.length &&
    decodedMixed[0] === 0x01 &&
    decodedMixed[1] === 0xc0 &&
    decodedMixed[2] === 0x02 &&
    decodedMixed[3] === 0xdb &&
    decodedMixed[4] === 0x03,
  'SLIP round-trip: mixed data'
);

// ---- HCI Packet tests ----------------------------------------------------
console.log('\n--- HCI Packet ---');

// Reset seq number
const pkt = new HciPacket(new Uint8Array([0x01, 0x02, 0x03, 0x04]));

// Check framing
assert(pkt.data[0] === 0xc0, 'HCI packet starts with 0xC0');
assert(pkt.data[pkt.data.length - 1] === 0xc0, 'HCI packet ends with 0xC0');
assert(pkt.data.length > 10, 'HCI packet has reasonable length');

// Payload: 4 bytes header + 4 bytes payload + 2 bytes CRC = 10 bytes before SLIP
// After SLIP encoding + 2 framing bytes
console.log(`  HCI packet length: ${pkt.data.length} bytes`);
console.log(`  HCI packet: ${pkt.toString()}`);

// ---- Intel HEX parser tests ---------------------------------------------
console.log('\n--- Intel HEX Parser ---');

// Simple test hex: 3 data bytes at address 0x1000, then EOF
// :03100000010203E7 → 3 bytes 01 02 03 at addr 0x1000
// :00000001FF       → EOF
const testHex = [
  ':03100000010203E7',
  ':00000001FF',
].join('\n');

const { buf, startAddr } = parseHex(testHex);
assert(buf.size === 3, 'parseHex: 3 bytes parsed');
assert(buf.get(0x1000) === 0x01, 'parseHex: addr 0x1000 = 0x01');
assert(buf.get(0x1001) === 0x02, 'parseHex: addr 0x1001 = 0x02');
assert(buf.get(0x1002) === 0x03, 'parseHex: addr 0x1002 = 0x03');
assert(startAddr === null, 'parseHex: no start address in test hex');

// Test with extended linear address record (type 04)
// :020000040001F9  → base = 0x0001 (→ 0x10000), checksum 0xF9
// :0400000001020304F2 → data 01 02 03 04 at offset 0x0000 → 0x10000
const testHexExt = [
  ':020000040001F9',
  ':0400000001020304F2',
  ':00000001FF',
].join('\n');
const { buf: buf2 } = parseHex(testHexExt);
assert(buf2.get(0x10000) === 0x01, 'parseHex ext addr: 0x10000 = 0x01');
assert(buf2.get(0x10003) === 0x04, 'parseHex ext addr: 0x10003 = 0x04');

// Checksum validation
const badHex = [
  ':03100000010203FF',  // wrong checksum (should be E7)
  ':00000001FF',
].join('\n');
try {
  parseHex(badHex);
  assert(false, 'parseHex: should have thrown on bad checksum');
} catch (e) {
  assert(e.name === 'HexChecksumError', 'parseHex: throws HexChecksumError on bad checksum');
}

// ---- extractBinaryFromHex tests -------------------------------------------
console.log('\n--- extractBinaryFromHex ---');

// Create test hex data in application region (addresses 0x1000-0x1004)
// :051000000102030405DC → 5 bytes 01 02 03 04 05 at 0x1000
const hexApp = [
  ':051000000102030405DC',
  ':00000001FF',
].join('\n');
const { buf: buf3 } = parseHex(hexApp);
const binary = extractBinaryFromHex(buf3);
assert(binary.length === 8, `extractBinary: length = ${binary.length} (expected 8, word-aligned)`);
assert(binary[0] === 0x01, 'extractBinary: byte 0 = 0x01');
assert(binary[4] === 0x05, 'extractBinary: byte 4 = 0x05');
assert(binary[7] === 0xff, 'extractBinary: padded byte = 0xff');

// Test with UICR addresses removed
// Extended linear addr 0x1000 → base = 0x10000000
// Then reset to 0 for app data
const hexWithUICR = [
  ':020000041000EA',   // Extended linear addr 0x1000 → 0x10000000
  ':02000000AABB99',   // 2 bytes AA BB at 0x0000 → 0x10000000 (UICR)
  ':020000040000FA',   // Reset extended addr back to 0
  ':03100000050607DB', // 3 bytes at 0x1000 (valid app region)
  ':00000001FF',
].join('\n');
const { buf: buf4 } = parseHex(hexWithUICR);
assert(buf4.has(0x10000000), 'extractBinary: UICR address present in map');
assert(buf4.get(0x10000000) === 0xAA, 'extractBinary: UICR data byte correct');
assert(buf4.has(0x1000), 'extractBinary: app address present in map');

// extractBinaryFromHex should remove UICR addresses
const cleaned = extractBinaryFromHex(new Map(buf4));
assert(cleaned.length > 0, 'extractBinary: produces output');
// The cleaned binary should be the app data only (3 bytes + padding = 4 bytes)
// starting from 0x1000: 05 06 07 FF
assert(cleaned.length === 4, `extractBinary: output length = ${cleaned.length} (expected 4)`);
assert(cleaned[0] === 0x05, 'extractBinary: cleaned byte 0 = 0x05');
assert(cleaned[1] === 0x06, 'extractBinary: cleaned byte 1 = 0x06');
assert(cleaned[2] === 0x07, 'extractBinary: cleaned byte 2 = 0x07');

// ---- Summary -------------------------------------------------------------
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
