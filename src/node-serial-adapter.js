/**
 * Node.js serial port adapter for DfuTransportSerial.
 *
 * Wraps the `serialport` npm package to provide the async read/write API
 * expected by DfuTransportSerial.
 *
 * Uses an internal buffer to accumulate incoming data so read() always
 * returns whatever is available without dropping bytes.
 */

import { SerialPort } from 'serialport';

export class NodeSerialAdapter {
  /**
   * @param {string} path - COM port path (e.g. "/dev/ttyACM0" or "COM3")
   * @param {Object} [options]
   * @param {number} [options.baudRate=115200]
   * @param {number} [options.readTimeout=100] - ms to wait on each read call
   * @param {number} [options.touchBaud=0] - If >0, perform "touch" reset before opening
   *        by briefly opening the port at this baud rate. Alternative to DTR toggle.
   */
  constructor(path, options = {}) {
    this.path = path;
    this.baudRate = options.baudRate || 115200;
    this.readTimeout = options.readTimeout || 100;
    this.touchBaud = options.touchBaud || 0;
    /** @type {SerialPort|null} */
    this.port = null;
    /** Internal buffer of received bytes. */
    this._buffer = [];
    /** @type {import('stream').Duplex|null} */
    this._portStream = null;
  }

  /**
   * Open the serial port and optionally enter DFU mode.
   *
   * Three reset methods (tried in order of preference):
   * 1. Touch reset: briefly open at touchBaud baud rate (e.g. 1200) to trigger DFU entry
   * 2. DTR toggle: if supported by the serial port
   * 3. No reset: assume the device is already in DFU mode
   *
   * @param {Object} [options]
   * @param {boolean} [options.useDtrReset=true] - Allow DTR toggle
   */
  async open(options = {}) {
    const useDtrReset = options.useDtrReset !== false;

    // Step 1: Touch reset (if configured)
    if (this.touchBaud > 0) {
      await this._doTouchReset();
    }

    // Step 2: Open the actual communication port
    this.port = new SerialPort({
      path: this.path,
      baudRate: this.baudRate,
      autoOpen: false,
    });

    await new Promise((resolve, reject) => {
      this.port.open((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Pipe serial data into internal buffer
    this.port.on('data', (data) => {
      for (let i = 0; i < data.length; i++) {
        this._buffer.push(data[i]);
      }
    });

    // Step 3: DTR toggle (only if no touch reset was used)
    if (useDtrReset && this.touchBaud === 0) {
      try {
        await this._setDtr(false);
        await this._sleep(50);
        await this._setDtr(true);
        await this._sleep(1500);
      } catch (err) {
        console.warn('DTR toggle not supported (' + err.message + '). Assuming device is already in DFU mode.');
      }
    }
  }

  /**
   * Perform a "touch" reset: briefly open the port at a different baud rate
   * to signal the bootloader to enter DFU mode.
   */
  async _doTouchReset() {
    const touchPort = new SerialPort({
      path: this.path,
      baudRate: this.touchBaud,
      autoOpen: false,
    });

    await new Promise((resolve, reject) => {
      touchPort.open((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Briefly hold the port open, then close
    await this._sleep(100);
    await new Promise((resolve) => touchPort.close(resolve));

    // Wait for the device to enter DFU mode and re-enumerate
    await this._sleep(2000);
  }

  /**
   * Write data to the serial port.
   * @param {Uint8Array} data
   * @returns {Promise<void>}
   */
  async write(data) {
    return new Promise((resolve, reject) => {
      this.port.write(Buffer.from(data), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Read up to `count` bytes from the serial port.
   *
   * Returns whatever is available in the internal buffer (up to `count` bytes),
   * waiting up to `readTimeout` ms if the buffer is empty.
   *
   * @param {number} count
   * @returns {Promise<Uint8Array>}
   */
  async read(count) {
    // Poll the buffer with timeout
    const start = Date.now();
    while (this._buffer.length === 0) {
      if (Date.now() - start > this.readTimeout) {
        break;
      }
      await this._sleep(5);
    }
    return this._drainBuffer(count);
  }

  /**
   * Close the serial port.
   * @returns {Promise<void>}
   */
  async close() {
    return new Promise((resolve) => {
      if (!this.port) return resolve();
      this.port.close((err) => {
        // Ignore close errors
        resolve();
      });
    });
  }

  /**
   * Drain up to `count` bytes from the internal buffer.
   * @param {number} count
   * @returns {Uint8Array}
   */
  _drainBuffer(count) {
    const available = Math.min(count, this._buffer.length);
    const result = new Uint8Array(available);
    for (let i = 0; i < available; i++) {
      result[i] = this._buffer.shift();
    }
    return result;
  }

  /**
   * Set the DTR signal.
   * @param {boolean} value
   */
  async _setDtr(value) {
    return new Promise((resolve, reject) => {
      this.port.set({ dtr: value }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
