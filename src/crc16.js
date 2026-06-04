/**
 * CRC16 calculation for nRF5x DFU protocol.
 *
 * Ported from nordicsemi/dfu/crc16.py
 *
 * @param {Uint8Array|number[]} data - Binary data to compute CRC16 over
 * @param {number} [crc=0xffff] - Initial CRC value
 * @returns {number} Calculated CRC16 value (16-bit)
 */
export function calcCrc16(data, crc = 0xffff) {
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    crc = ((crc >> 8) & 0x00ff) | ((crc << 8) & 0xff00);
    crc ^= b;
    crc ^= (crc & 0x00ff) >> 4;
    crc ^= (crc << 8) << 4;
    crc ^= ((crc & 0x00ff) << 4) << 1;
  }
  return crc & 0xffff;
}
