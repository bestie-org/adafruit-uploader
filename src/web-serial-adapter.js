/**
 * Web Serial API adapter for DfuTransportSerial.
 *
 * Wraps the browser's Web Serial API (`navigator.serial`) so it can be
 * used with DfuTransportSerial in the browser.
 *
 * Usage:
 * ```js
 * const adapter = new WebSerialAdapter();
 * await adapter.requestPort();        // user gesture required
 * await adapter.open();               // open + DTR toggle
 * const transport = new DfuTransportSerial(adapter);
 * // ... use transport
 * ```
 */

export class WebSerialAdapter {
  constructor() {
    /** @type {SerialPort|null} */
    this.port = null;
    /** @type {ReadableStreamDefaultReader|null} */
    this.reader = null;
    /** @type {WritableStreamDefaultWriter|null} */
    this.writer = null;
  }

  /**
   * Request a serial port from the user (requires user gesture).
   * @param {Object} [filters] - Optional filters (e.g. USB vendor/product IDs)
   * @returns {Promise<boolean>} true if a port was selected
   */
  async requestPort(filters) {
    if (!navigator.serial) {
      throw new Error('Web Serial API not available in this browser.');
    }
    const options = {};
    if (filters) {
      options.filters = Array.isArray(filters) ? filters : [filters];
    }
    try {
      this.port = await navigator.serial.requestPort(options);
      return true;
    } catch (err) {
      if (err.name === 'NotFoundError') {
        return false; // user cancelled
      }
      throw err;
    }
  }

  /**
   * Open the serial port and optionally toggle DTR to enter DFU mode.
   *
   * @param {Object} [options]
   * @param {number} [options.baudRate=115200]
   * @param {boolean} [options.useDtrReset=true] - Toggle DTR to enter DFU
   */
  async open(options = {}) {
    if (!this.port) {
      throw new Error('No serial port selected. Call requestPort() first.');
    }

    const baudRate = options.baudRate || 115200;
    const useDtrReset = options.useDtrReset !== false;

    await this.port.open({ baudRate });

    // Set up streams
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();

    if (useDtrReset) {
      try {
        // Toggle DTR to reset the board and enter DFU mode
        await this._setDtr(false);
        await this._sleep(50);
        await this._setDtr(true);
        // Wait for device to boot into DFU mode
        await this._sleep(1500);
      } catch (err) {
        console.warn('DTR toggle not supported by this device. Assuming DFU mode already active.');
      }
    }
  }

  /**
   * Write data to the serial port.
   * @param {Uint8Array} data
   * @returns {Promise<void>}
   */
  async write(data) {
    if (!this.writer) {
      throw new Error('Serial port not open.');
    }
    await this.writer.write(data);
  }

  /**
   * Read up to `count` bytes from the serial port.
   *
   * Note: Web Serial API reads are buffered; this returns whatever is
   * available, up to `count` bytes. If no data is available yet, it
   * waits for at least one chunk.
   *
   * @param {number} count
   * @returns {Promise<Uint8Array>}
   */
  async read(count) {
    if (!this.reader) {
      throw new Error('Serial port not open.');
    }
    try {
      const { value, done } = await this.reader.read();
      if (done) {
        return new Uint8Array(0);
      }
      // Return at most `count` bytes
      return value.slice(0, count);
    } catch (err) {
      // If the stream is closed/cancelled, return empty
      return new Uint8Array(0);
    }
  }

  /**
   * Close the serial port and release streams.
   * @returns {Promise<void>}
   */
  async close() {
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader = null;
      }
      if (this.writer) {
        await this.writer.close();
        this.writer = null;
      }
      if (this.port) {
        await this.port.close();
      }
    } catch {
      // Ignore close errors
    }
  }

  /**
   * Set the DTR signal via the Web Serial API.
   * @param {boolean} value
   */
  async _setDtr(value) {
    if (this.port && this.port.setSignals) {
      await this.port.setSignals({ dtr: value });
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
