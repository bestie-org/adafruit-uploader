/**
 * Utility functions for nRF5x DFU serial protocol.
 *
 * Ported from nordicsemi/dfu/util.py
 */

import { NordicSemiException } from './exceptions.js';

/**
 * Convert a 16-bit unsigned integer to a Uint8Array of 2 bytes (little-endian).
 * @param {number} value
 * @returns {Uint8Array}
 */
export function uint16ToBytes(value) {
  const buf = new Uint8Array(2);
  buf[0] = value & 0xff;
  buf[1] = (value >> 8) & 0xff;
  return buf;
}

/**
 * Convert a 32-bit unsigned integer to a Uint8Array of 4 bytes (little-endian).
 * @param {number} value
 * @returns {Uint8Array}
 */
export function uint32ToBytes(value) {
  const buf = new Uint8Array(4);
  buf[0] = value & 0xff;
  buf[1] = (value >> 8) & 0xff;
  buf[2] = (value >> 16) & 0xff;
  buf[3] = (value >> 24) & 0xff;
  return buf;
}

/**
 * Convert a 32-bit integer to a Uint8Array of 4 bytes (little-endian).
 * Alias matching Python int32_to_bytes name.
 * @param {number} value
 * @returns {Uint8Array}
 */
export function int32ToBytes(value) {
  return uint32ToBytes(value >>> 0);
}

/**
 * Convert a 16-bit integer to a Uint8Array of 2 bytes (little-endian).
 * Alias matching Python int16_to_bytes name.
 * @param {number} value
 * @returns {Uint8Array}
 */
export function int16ToBytes(value) {
  return uint16ToBytes(value & 0xffff);
}

/**
 * Create a 4-byte SLIP header.
 *
 * Header layout:
 *   byte0: seq | ((seq+1)%8)<<3 | dip<<6 | rp<<7
 *   byte1: pkt_type | (pkt_len & 0x000F)<<4
 *   byte2: (pkt_len & 0x0FF0) >> 4
 *   byte3: checksum = ~(sum(byte0..2)) + 1
 *
 * @param {number} seq - Packet sequence number (0-7)
 * @param {number} dip - Data integrity check present flag
 * @param {number} rp  - Reliable packet flag
 * @param {number} pktType - Payload packet type
 * @param {number} pktLen - Payload length
 * @returns {Uint8Array} 4-byte header
 */
export function slipPartsToFourBytes(seq, dip, rp, pktType, pktLen) {
  const ints = new Uint8Array(4);
  ints[0] = seq | (((seq + 1) % 8) << 3) | (dip << 6) | (rp << 7);
  ints[1] = pktType | ((pktLen & 0x000f) << 4);
  ints[2] = (pktLen & 0x0ff0) >> 4;
  ints[3] = (~(ints[0] + ints[1] + ints[2]) + 1) & 0xff;
  return ints;
}

/**
 * SLIP-encode a Uint8Array.
 *
 * Replaces 0xC0 with 0xDB 0xDC and 0xDB with 0xDB 0xDD.
 *
 * @param {Uint8Array} data - Data to encode
 * @returns {Uint8Array} Encoded data
 */
export function slipEncodeEscChars(data) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte === 0xc0) {
      result.push(0xdb, 0xdc);
    } else if (byte === 0xdb) {
      result.push(0xdb, 0xdd);
    } else {
      result.push(byte);
    }
  }
  return new Uint8Array(result);
}

/**
 * SLIP-decode a byte array (mutates the input array by popping).
 *
 * Replaces 0xDB 0xDC with 0xC0 and 0xDB 0xDD with 0xDB.
 *
 * @param {number[]} data - Array of bytes (will be mutated)
 * @returns {number[]} Decoded bytes
 */
export function slipDecodeEscChars(data) {
  const result = [];
  while (data.length > 0) {
    const char = data.shift();
    if (char === 0xdb) {
      if (data.length === 0) {
        throw new NordicSemiException('SLIP decode: unexpected end after 0xDB');
      }
      const char2 = data.shift();
      if (char2 === 0xdc) {
        result.push(0xc0);
      } else if (char2 === 0xdd) {
        result.push(0xdb);
      } else {
        throw new NordicSemiException(
          `SLIP decode: 0xDB not followed by 0xDC or 0xDD, got 0x${char2.toString(16)}`
        );
      }
    } else {
      result.push(char);
    }
  }
  return result;
}

/**
 * Convert a Uint8Array to a hex string for debugging.
 * @param {Uint8Array|number[]} data
 * @returns {string}
 */
export function toHexString(data) {
  const arr = data instanceof Uint8Array ? Array.from(data) : data;
  return arr.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' ');
}
