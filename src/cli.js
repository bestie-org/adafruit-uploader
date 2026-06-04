#!/usr/bin/env node

/**
 * CLI tool for serial DFU upload to nRF52 boards.
 *
 * Usage:
 *   node src/cli.js --port /dev/ttyACM0 --firmware firmware.hex --dat initpacket.dat
 *
 * Supports both .hex (Intel HEX) and .bin firmware files.
 * For testing/debugging from command line.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';
import { NodeSerialAdapter } from './node-serial-adapter.js';
import { DfuTransportSerial, DfuEvent, DFU_UPDATE_MODE_APP } from './dfu-transport-serial.js';
import { NordicSemiException } from './exceptions.js';
import { parseHex, extractBinaryFromHex } from './intelhex.js';
import { generateMinimalInitPacket } from './init-packet.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
      case '-p':
        opts.port = args[++i];
        break;
      case '--firmware':
      case '-f':
        opts.firmware = resolve(args[++i]);
        break;
      case '--dat':
      case '-d':
        opts.dat = resolve(args[++i]);
        break;
      case '--baud':
      case '-b':
        opts.baudRate = parseInt(args[++i], 10);
        break;
      case '--single-bank':
      case '-s':
        opts.singleBank = true;
        break;
      case '--touch':
      case '-t':
        opts.touch = parseInt(args[++i], 10);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  if (!opts.port || !opts.firmware) {
    console.error('Error: --port and --firmware are required.');
    printHelp();
    process.exit(1);
  }

  return opts;
}

function printHelp() {
  console.log(`
nRF52 Serial DFU Uploader (JS)

Usage:
  node src/cli.js --port <port> --firmware <file> [options]

Options:
  -p, --port <port>        Serial port (e.g. /dev/ttyACM0, COM3)  [required]
  -f, --firmware <file>    Firmware file (.bin or .hex)           [required]
  -d, --dat <file>         Init packet (.dat)                      [optional]
  -b, --baud <baud>        Baud rate (default: 115200)
  -b, --baud <baud>        Baud rate (default: 115200)
  -s, --single-bank        Use single bank mode                    [optional]
  -t, --touch <baud>       Touch reset at given baud before DFU     [optional]
  -h, --help               Show this help
`);
}

/** Simple progress callback */
const printedProgress = new Set();
function onProgress({ progress, done, logMessage }) {
  if (progress === 0) return;
  const pct = Math.round(progress);
  if (!printedProgress.has(pct) && (pct % 10 === 0 || pct === 100)) {
    printedProgress.add(pct);
    process.stdout.write(`\rProgress: ${pct}%`);
  }
  if (done) {
    process.stdout.write('\n');
  }
}

async function main() {
  const opts = parseArgs();

  // Read firmware binary (supports .hex and .bin)
  if (!existsSync(opts.firmware)) {
    console.error(`Error: Firmware file not found: ${opts.firmware}`);
    process.exit(1);
  }

  let firmware;
  const ext = extname(opts.firmware).toLowerCase();
  if (ext === '.hex' || ext === '.ihx') {
    const hexData = readFileSync(opts.firmware, 'utf-8');
    const { buf } = parseHex(hexData);
    firmware = extractBinaryFromHex(buf);
    console.log(`Firmware: ${opts.firmware} (Intel HEX → ${firmware.length} bytes binary)`);
  } else {
    firmware = readFileSync(opts.firmware);
    console.log(`Firmware: ${opts.firmware} (${firmware.length} bytes binary)`);
  }

  // Read or generate init packet
  let initPacket = null;
  if (opts.dat) {
    if (!existsSync(opts.dat)) {
      console.error(`Error: Init packet file not found: ${opts.dat}`);
      process.exit(1);
    }
    initPacket = readFileSync(opts.dat);
    console.log(`Init packet: ${opts.dat} (${initPacket.length} bytes)`);
  } else {
    console.log('No .dat file provided — auto-generating init packet...');
    initPacket = generateMinimalInitPacket(firmware, {
      deviceType: 0x0052,
      deviceRev: 52840,      // nRF52840
      appVersion: 0xFFFFFFFF, // any
      softdeviceReq: [0xFFFE], // any SoftDevice
    });
    console.log(`Generated init packet: ${initPacket.length} bytes`);
  }

  // Open serial port
  const adapter = new NodeSerialAdapter(opts.port, {
    baudRate: opts.baudRate || 115200,
    touchBaud: opts.touch || 0,
  });

  console.log(`Opening ${opts.port} at ${opts.baudRate || 115200} baud...`);
  if (opts.touch) {
    console.log(`Touch reset at ${opts.touch} baud...`);
  }
  await adapter.open({ useDtrReset: true });
  console.log('Port opened.');

  const transport = new DfuTransportSerial(adapter, {
    singleBank: !!opts.singleBank,
  });

  transport.registerEventsCallback(DfuEvent.PROGRESS_EVENT, onProgress);
  transport.registerEventsCallback(DfuEvent.TIMEOUT_EVENT, ({ logMessage }) => {
    console.error(`\nTimeout: ${logMessage}`);
  });
  transport.registerEventsCallback(DfuEvent.ERROR_EVENT, ({ logMessage }) => {
    console.error(`\nError: ${logMessage}`);
  });

  try {
    // Step 1: Send start DFU packet
    console.log('Sending DFU start packet...');
    await transport.sendStartDfu(DFU_UPDATE_MODE_APP, 0, 0, firmware.length);

    // Step 2: Send init packet
    console.log('Sending init packet...');
    await transport.sendInitPacket(initPacket);

    // Step 3: Send firmware
    console.log('Sending firmware...');
    await transport.sendFirmware(firmware);

    // Step 4: Validate
    transport.sendValidateFirmware();

    // Step 5: Activate
    console.log('\nActivating firmware...');
    await transport.sendActivateFirmware();

    // Wait for bootloader to finish copying the firmware and reset
    const waitTime = transport.getActivateWaitTime();
    console.log(`Waiting ${waitTime.toFixed(1)}s for activation...`);
    await new Promise(r => setTimeout(r, waitTime * 1000));

    console.log('\n✅ Firmware uploaded successfully!');
  } catch (err) {
    console.error(`\n❌ Failed: ${err.message}`);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  } finally {
    try { await adapter.close(); } catch {}
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
