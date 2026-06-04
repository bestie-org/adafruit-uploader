/**
 * nRF5x DFU Init Packet Generator.
 *
 * Builds the binary init packet (.dat) required by the Adafruit nRF52 bootloader.
 *
 * Ported from nordicsemi/dfu/init_packet.py
 *
 * For non-signed firmware (the common case), the init packet contains:
 *   - device_type (uint16 LE)
 *   - device_rev  (uint16 LE)
 *   - app_version (uint32 LE)
 *   - softdevice_len (uint16 LE)
 *   - softdevice[] (uint16 LE array)
 *   - extended data: CRC16 of the firmware (uint16 LE)
 */

import { calcCrc16 } from './crc16.js';
import { uint16ToBytes, uint32ToBytes } from './util.js';

/** Adafruit device type constant used by the bootloader. */
export const ADAFRUIT_DEVICE_TYPE = 0x0052;

/** SoftDevice firmware ID meaning "any SoftDevice is accepted". */
export const DFU_SOFTDEVICE_ANY = 0xfffe;

/**
 * Packet extension identifiers.
 */
export const INIT_PACKET_USES_CRC16 = 0;
export const INIT_PACKET_USES_HASH = 1;
export const INIT_PACKET_EXT_USES_ECDS = 2;

/**
 * Fields for the init packet, matching PacketField enum from Python.
 * Values are Python Enum .value numbers used for ordering the struct fields.
 */
export const PacketField = Object.freeze({
  DEVICE_TYPE: 1,
  DEVICE_REVISION: 2,
  APP_VERSION: 3,
  REQUIRED_SOFTDEVICES_ARRAY: 4,
  NORDIC_PROPRIETARY_OPT_DATA_EXT_PACKET_ID: 6,
  NORDIC_PROPRIETARY_OPT_DATA_FIRMWARE_LENGTH: 7,
  NORDIC_PROPRIETARY_OPT_DATA_FIRMWARE_HASH: 8,
  NORDIC_PROPRIETARY_OPT_DATA_FIRMWARE_CRC16: 9,
  NORDIC_PROPRIETARY_OPT_DATA_INIT_PACKET_ECDS: 10,
});

/**
 * Generate a minimal init packet for the Adafruit nRF52 bootloader.
 *
 * This produces a valid .dat file for non-signed firmware updates,
 * using CRC16 for integrity checking (DFU version 0.5 compatible).
 *
 * @param {Uint8Array} firmwareBinary - The complete firmware binary
 * @param {Object} [options]
 * @param {number} [options.deviceType=0x0052] - Device type (Adafruit)
 * @param {number} [options.deviceRev=52840] - Device revision (52840 for nRF52840)
 * @param {number} [options.appVersion=0xFFFFFFFF] - Application version
 * @param {number[]} [options.softdeviceReq=[0xFFFE]] - Required SoftDevice FW IDs
 * @returns {Uint8Array} The raw init packet bytes (.dat content)
 */
export function generateMinimalInitPacket(firmwareBinary, options = {}) {
  const deviceType = options.deviceType !== undefined ? options.deviceType : ADAFRUIT_DEVICE_TYPE;
  const deviceRev = options.deviceRev !== undefined ? options.deviceRev : 52840;
  const appVersion = options.appVersion !== undefined ? options.appVersion : 0xffffffff;
  const softdeviceReq = options.softdeviceReq || [DFU_SOFTDEVICE_ANY];

  // Calculate the CRC16 of the firmware
  const firmwareCrc = calcCrc16(firmwareBinary, 0xffff);

  // Build the binary init packet
  // Layout (all little-endian):
  //   0: device_type   (uint16)
  //   2: device_rev    (uint16)
  //   4: app_version   (uint32)
  //   8: sd_len        (uint16) — number of entries in softdevice array
  //  10: softdevice[]  (uint16 × sd_len)
  //  then extended data:
  //   +0: CRC16        (uint16) — firmware CRC

  const headerSize = 2 + 2 + 4 + 2; // without softdevice array
  const sdArraySize = softdeviceReq.length * 2;
  const extSize = 2; // CRC16 only

  const packet = new Uint8Array(headerSize + sdArraySize + extSize);

  let offset = 0;
  // device_type
  packet.set(uint16ToBytes(deviceType), offset); offset += 2;
  // device_rev
  packet.set(uint16ToBytes(deviceRev), offset); offset += 2;
  // app_version
  packet.set(uint32ToBytes(appVersion), offset); offset += 4;
  // softdevice_len
  packet.set(uint16ToBytes(softdeviceReq.length), offset); offset += 2;
  // softdevice array
  for (const sd of softdeviceReq) {
    packet.set(uint16ToBytes(sd), offset); offset += 2;
  }
  // Extended data: CRC16
  packet.set(uint16ToBytes(firmwareCrc), offset);

  return packet;
}
