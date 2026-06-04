/**
 * nRF5x Serial DFU Transport — JavaScript port.
 *
 * Implements the SLIP-framed HCI-over-UART protocol used by the
 * Adafruit nRF52 bootloader (serial DFU mode).
 *
 * Ported from nordicsemi/dfu/dfu_transport_serial.py
 */

import { calcCrc16 } from './crc16.js';
import {
  slipPartsToFourBytes,
  slipEncodeEscChars,
  slipDecodeEscChars,
  int32ToBytes,
  int16ToBytes,
  toHexString,
} from './util.js';
import { NordicSemiException } from './exceptions.js';

// ---- Constants -----------------------------------------------------------

const DATA_INTEGRITY_CHECK_PRESENT = 1;
const RELIABLE_PACKET = 1;
const HCI_PACKET_TYPE = 14;

export const DFU_INIT_PACKET = 1;
export const DFU_START_PACKET = 3;
export const DFU_DATA_PACKET = 4;
export const DFU_STOP_DATA_PACKET = 5;

export const DFU_UPDATE_MODE_NONE = 0;
export const DFU_UPDATE_MODE_SD = 1;
export const DFU_UPDATE_MODE_BL = 2;
export const DFU_UPDATE_MODE_APP = 4;

// ---- Events --------------------------------------------------------------

export const DfuEvent = Object.freeze({
  PROGRESS_EVENT: 1,
  TIMEOUT_EVENT: 2,
  ERROR_EVENT: 3,
});

// ---- HCI Packet ----------------------------------------------------------

let globalSequenceNumber = 0;

/**
 * Represents a single HCI packet framed with SLIP encoding and CRC16.
 *
 * Packet format:
 *   0xC0 | SLIP-encoded(4-byte-header | payload | CRC16) | 0xC0
 */
export class HciPacket {
  /**
   * @param {Uint8Array} data - Payload bytes
   */
  constructor(data) {
    const seq = (globalSequenceNumber + 1) % 8;
    globalSequenceNumber = seq;

    // 4-byte SLIP header
    const header = slipPartsToFourBytes(
      seq,
      DATA_INTEGRITY_CHECK_PRESENT,
      RELIABLE_PACKET,
      HCI_PACKET_TYPE,
      data.length
    );

    // Build inner payload: header + data + CRC16 (2 bytes LE)
    const inner = new Uint8Array(header.length + data.length + 2);
    inner.set(header, 0);
    inner.set(data, header.length);

    const crc = calcCrc16(inner.subarray(0, header.length + data.length), 0xffff);
    inner[inner.length - 2] = crc & 0xff;
    inner[inner.length - 1] = (crc >> 8) & 0xff;

    // SLIP-encode the inner payload
    const encoded = slipEncodeEscChars(inner);

    // Final frame: 0xC0 + encoded + 0xC0
    this.data = new Uint8Array(1 + encoded.length + 1);
    this.data[0] = 0xc0;
    this.data.set(encoded, 1);
    this.data[this.data.length - 1] = 0xc0;
  }

  toString() {
    return toHexString(this.data);
  }
}

/** Reset the global HCI sequence number (e.g. on timeout). */
export function resetHciSequenceNumber() {
  globalSequenceNumber = 0;
}

// ---- DFU Transport Base --------------------------------------------------

/**
 * Abstract base for DFU transports.
 * Provides event callback registration.
 */
export class DfuTransport {
  constructor() {
    /** @type {Object<number, Function[]>} */
    this.callbacks = {};
  }

  /** @returns {boolean} */
  isOpen() {
    return false;
  }

  open() {}
  close() {}

  sendStartDfu(programMode, softdeviceSize = 0, bootloaderSize = 0, appSize = 0) {
    // to be overridden
  }

  sendInitPacket(initPacket) {
    // to be overridden
  }

  sendFirmware(firmware) {
    // to be overridden
  }

  sendValidateFirmware() {
    return true;
  }

  sendActivateFirmware() {}

  /**
   * Create the 12-byte image-size block for the start DFU packet.
   * @param {number} softdeviceSize
   * @param {number} bootloaderSize
   * @param {number} appSize
   * @returns {Uint8Array}
   */
  static createImageSizePacket(softdeviceSize = 0, bootloaderSize = 0, appSize = 0) {
    const sd = int32ToBytes(softdeviceSize);
    const bl = int32ToBytes(bootloaderSize);
    const app = int32ToBytes(appSize);
    const combined = new Uint8Array(sd.length + bl.length + app.length);
    combined.set(sd, 0);
    combined.set(bl, sd.length);
    combined.set(app, sd.length + bl.length);
    return combined;
  }

  /**
   * Register a callback for a given event type.
   * @param {number} eventType - One of DfuEvent values
   * @param {Function} callback
   */
  registerEventsCallback(eventType, callback) {
    if (!this.callbacks[eventType]) {
      this.callbacks[eventType] = [];
    }
    this.callbacks[eventType].push(callback);
  }

  /**
   * Unregister a callback.
   * @param {Function} callback
   */
  unregisterEventsCallback(callback) {
    for (const eventType of Object.keys(this.callbacks)) {
      const idx = this.callbacks[eventType].indexOf(callback);
      if (idx !== -1) {
        this.callbacks[eventType].splice(idx, 1);
      }
    }
  }

  /**
   * Fire an event to all registered callbacks.
   * @param {number} eventType
   * @param {Object} kwargs
   */
  _sendEvent(eventType, kwargs = {}) {
    if (this.callbacks[eventType]) {
      for (const cb of this.callbacks[eventType]) {
        cb(kwargs);
      }
    }
  }
}

// ---- Serial DFU Transport ------------------------------------------------

/**
 * Default baud rate for the serial DFU protocol.
 */
export const DEFAULT_BAUD_RATE = 115200;

/**
 * Serial DFU transport implementation.
 *
 * This class encapsulates the low-level SLIP-framed HCI protocol used by
 * the Adafruit nRF52 bootloader over UART.
 *
 * The `serialPort` parameter should be an object that conforms to a subset
 * of the Web Serial API or the `node-serialport` API:
 *
 *   - `write(data: Uint8Array): Promise<void>`
 *   - `read(count: number): Promise<Uint8Array>`  (or setReadCallback)
 *   - `setSignals({ dtr: boolean }): Promise<void>`
 *   - `close(): Promise<void>`
 *
 * For Node.js CLI usage, see `cli.js` which uses the `serialport` npm package.
 * For browser usage, see `web-dfu-transport.js` which wraps the Web Serial API.
 */
export class DfuTransportSerial extends DfuTransport {
  static FLASH_PAGE_SIZE = 4096;
  static FLASH_PAGE_ERASE_TIME = 0.0897; // seconds (nRF52840 max ~85ms)
  static FLASH_WORD_WRITE_TIME = 0.0001; // seconds (nRF52840 ~41us)
  static FLASH_PAGE_WRITE_TIME =
    (DfuTransportSerial.FLASH_PAGE_SIZE / 4) * DfuTransportSerial.FLASH_WORD_WRITE_TIME;
  static DFU_PACKET_MAX_SIZE = 512;

  /**
   * @param {Object} serialPort - Async serial port adapter
   * @param {Object} [options]
   * @param {boolean} [options.singleBank=false]
   * @param {number} [options.timeout=2000] - ACK timeout in ms
   */
  constructor(serialPort, options = {}) {
    super();
    this.serialPort = serialPort;
    this.singleBank = options.singleBank || false;
    this.ackTimeoutMs = options.timeout || 2000;

    // Calculated during sendStartDfu
    this.sdSize = 0;
    this.totalSize = 167936; // default max application size
  }

  // ---- Timing helpers ----------------------------------------------------

  /** @returns {number} Expected erase time in seconds */
  getEraseWaitTime() {
    const pages = Math.floor(this.totalSize / DfuTransportSerial.FLASH_PAGE_SIZE) + 1;
    return Math.max(0.5, pages * DfuTransportSerial.FLASH_PAGE_ERASE_TIME);
  }

  /** @returns {number} Expected activation time in seconds */
  getActivateWaitTime() {
    if (this.singleBank && this.sdSize === 0) {
      // Single bank, no SD update — just one page erase + write for settings
      return DfuTransportSerial.FLASH_PAGE_ERASE_TIME + DfuTransportSerial.FLASH_PAGE_WRITE_TIME;
    }
    const pages = Math.floor(this.totalSize / DfuTransportSerial.FLASH_PAGE_SIZE) + 1;
    const eraseTime = pages * DfuTransportSerial.FLASH_PAGE_ERASE_TIME;
    const writeTime = pages * DfuTransportSerial.FLASH_PAGE_WRITE_TIME;
    return eraseTime + writeTime;
  }

  // ---- High-level DFU procedure ------------------------------------------

  /**
   * Send the DFU start packet.
   *
   * @param {number} mode - One of DFU_UPDATE_MODE_*
   * @param {number} [softdeviceSize=0]
   * @param {number} [bootloaderSize=0]
   * @param {number} [appSize=0]
   */
  async sendStartDfu(mode, softdeviceSize = 0, bootloaderSize = 0, appSize = 0) {
    // DFU_START_PACKET opcode + mode + 3 image sizes = 4 + 4 + 12 = 20 bytes
    const frame = new Uint8Array(4 + 4 + 12);
    // DFU_START_PACKET opcode (4 bytes LE)
    frame.set(int32ToBytes(DFU_START_PACKET), 0);
    // mode (4 bytes LE)
    frame.set(int32ToBytes(mode), 4);
    // image sizes (12 bytes = 3 × 4)
    frame.set(DfuTransport.createImageSizePacket(softdeviceSize, bootloaderSize, appSize), 8);

    const packet = new HciPacket(frame);
    await this._sendPacket(packet);

    this.sdSize = softdeviceSize;
    this.totalSize = softdeviceSize + bootloaderSize + appSize;

    // Wait for flash erase to complete
    await this._sleep(this.getEraseWaitTime());
  }

  /**
   * Send the init packet (the .dat file contents).
   * @param {Uint8Array} initPacket - Raw init packet bytes
   */
  async sendInitPacket(initPacket) {
    const frame = new Uint8Array(4 + initPacket.length + 2);
    frame.set(int32ToBytes(DFU_INIT_PACKET), 0);
    frame.set(initPacket, 4);
    // 2 bytes padding
    frame[frame.length - 2] = 0x00;
    frame[frame.length - 1] = 0x00;

    const packet = new HciPacket(frame);
    await this._sendPacket(packet);
  }

  /**
   * Send the firmware binary in 512-byte chunks.
   * @param {Uint8Array} firmware - Full firmware binary
   */
  async sendFirmware(firmware) {
    const maxSize = DfuTransportSerial.DFU_PACKET_MAX_SIZE;
    const totalChunks = Math.ceil(firmware.length / maxSize);

    this._sendEvent(DfuEvent.PROGRESS_EVENT, { progress: 0, done: false, logMessage: '' });

    for (let i = 0; i < firmware.length; i += maxSize) {
      const chunk = firmware.subarray(i, i + maxSize);
      const frame = new Uint8Array(4 + chunk.length);
      frame.set(int32ToBytes(DFU_DATA_PACKET), 0);
      frame.set(chunk, 4);

      const packet = new HciPacket(frame);
      await this._sendPacket(packet);

      this._sendEvent(DfuEvent.PROGRESS_EVENT, {
        progress: Math.floor((i / firmware.length) * 100),
        done: false,
        logMessage: '',
      });

      // Every 8 frames (4096 bytes) the bootloader erases/writes a flash page.
      // During that time the CPU is blocked, so we wait briefly.
      const chunkIndex = i / maxSize;
      if (chunkIndex % 8 === 0) {
        await this._sleep(DfuTransportSerial.FLASH_PAGE_WRITE_TIME);
      }
    }

    // Wait for the last page to finish writing
    await this._sleep(DfuTransportSerial.FLASH_PAGE_WRITE_TIME);

    // Send stop-data packet
    const stopFrame = int32ToBytes(DFU_STOP_DATA_PACKET);
    const stopPacket = new HciPacket(stopFrame);
    await this._sendPacket(stopPacket);

    this._sendEvent(DfuEvent.PROGRESS_EVENT, { progress: 100, done: false, logMessage: '' });
  }

  /**
   * Send the activate firmware command.
   * (In the serial DFU protocol, activation is triggered by a host message
   * after the stop-data packet. This implementation logs the step.)
   */
  async sendActivateFirmware() {
    // In the Adafruit bootloader, activation is automatic after receiving
    // a valid firmware. The stop-data packet already tells the bootloader
    // to validate and switch.
    console.log('Activating new firmware');
  }

  // ---- Low-level send / receive ------------------------------------------

  /**
   * Send a single HCI packet and wait for ACK.
   * @param {HciPacket} pkt
   */
  async _sendPacket(pkt) {
    await this.serialPort.write(pkt.data);
    // Wait for the ACK from the bootloader
    await this._getAckNr();
  }

  /**
   * Read a SLIP-framed ACK from the serial port and extract the ACK number.
   *
   * The bootloader ACK is a 6-byte SLIP frame:
   *   0xC0 [4-byte header] 0xC0
   *
   * The ACK number is in bits [5:3] of the first header byte.
   *
   * @returns {number} ACK number (0-7)
   */
  async _getAckNr() {
    const startTime = Date.now();
    // Buffer to accumulate raw bytes from the serial port
    const raw = [];

    while (true) {
      if (Date.now() - startTime > this.ackTimeoutMs) {
        resetHciSequenceNumber();
        this._sendEvent(DfuEvent.TIMEOUT_EVENT, {
          logMessage: 'Timed out waiting for acknowledgement from device.',
        });
        throw new NordicSemiException('ACK timeout');
      }

      // Read whatever is available
      const chunk = await this.serialPort.read(64);
      if (chunk && chunk.length > 0) {
        for (let i = 0; i < chunk.length; i++) {
          raw.push(chunk[i]);
        }
      } else {
        await this._sleep(0.01);
        continue;
      }

      // Look for a complete SLIP frame: 0xC0 ... 0xC0
      const firstC0 = raw.indexOf(0xc0);
      if (firstC0 === -1) continue; // no frame start yet

      const secondC0 = raw.indexOf(0xc0, firstC0 + 1);
      if (secondC0 === -1) continue; // no frame end yet

      // We have a complete frame. Extract the inner bytes.
      const innerBytes = raw.slice(firstC0 + 1, secondC0);

      // SLIP-decode the inner content
      const decoded = slipDecodeEscChars(innerBytes);

      // Remove consumed bytes from raw buffer (including both 0xC0 markers)
      raw.splice(0, secondC0 + 1);

      if (decoded.length < 4) {
        // Too short to be a valid ACK header
        continue;
      }

      // ACK number is in bits [5:3] of the first header byte
      // Also, verify the header checksum: (hdr[0]+hdr[1]+hdr[2]+hdr[3]) & 0xFF === 0
      const csum = (decoded[0] + decoded[1] + decoded[2] + decoded[3]) & 0xff;
      if (csum !== 0) {
        // Bad checksum, skip this frame and look for the next
        continue;
      }

      return (decoded[0] >> 3) & 0x07;
    }
  }

  /**
   * Sleep for a given number of seconds.
   * @param {number} seconds
   * @returns {Promise<void>}
   */
  _sleep(seconds) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}
