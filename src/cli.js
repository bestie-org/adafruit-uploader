#!/usr/bin/env node

/**
 * CLI tool for serial DFU upload to nRF52 boards.
 *
 * Usage:
 *   Single .hex (auto-detect):
 *     node src/cli.js --port /dev/ttyACM0 --firmware merged.hex
 *
 *   Separate components:
 *     node src/cli.js --port /dev/ttyACM0 --softdevice s140.hex --application app.hex
 *
 *   With explicit init packet (.dat):
 *     node src/cli.js --port /dev/ttyACM0 --firmware fw.hex --dat init.dat
 *
 *   Specify MCU (needed for softdevice update):
 *     node src/cli.js --port /dev/ttyACM0 --firmware fw.hex --mcu 52840
 *
 * Supports both .hex (Intel HEX) and .bin firmware files.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';
import { NodeSerialAdapter } from './node-serial-adapter.js';
import {
  DfuTransportSerial, DfuEvent,
  DFU_UPDATE_MODE_SD, DFU_UPDATE_MODE_BL, DFU_UPDATE_MODE_APP,
} from './dfu-transport-serial.js';
import { NordicSemiException } from './exceptions.js';
import { parseHex, extractBinaryFromHex, extractRegionBinary } from './intelhex.js';
import { analyzeHexString } from './hex-analyzer.js';
import { generateMinimalInitPacket } from './init-packet.js';

const DEFAULT_DEV_REV = {
  52840: 52840,
  52833: 52833,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port': case '-p':       opts.port = args[++i]; break;
      case '--firmware': case '-f':   opts.firmware = resolve(args[++i]); break;
      case '--dat': case '-d':        opts.dat = resolve(args[++i]); break;
      case '--baud': case '-b':       opts.baudRate = parseInt(args[++i], 10); break;
      case '--single-bank': case '-s': opts.singleBank = true; break;
      case '--touch': case '-t':      opts.touch = parseInt(args[++i], 10); break;
      case '--mcu': case '-m':        opts.mcu = parseInt(args[++i], 10); break;
      case '--softdevice':            opts.softdevice = resolve(args[++i]); break;
      case '--bootloader':            opts.bootloader = resolve(args[++i]); break;
      case '--application':           opts.application = resolve(args[++i]); break;
      case '--analyze': case '-a':    opts.analyze = resolve(args[++i]); break;
      case '--help': case '-h':
        printHelp();
        process.exit(0);
    }
  }

  if (!opts.port && !opts.analyze) {
    console.error('Error: --port is required (or use --analyze to inspect a .hex file).');
    printHelp();
    process.exit(1);
  }

  return opts;
}

function printHelp() {
  console.log(`
nRF52 Serial DFU Uploader (JS)

Single .hex (auto-detect):
  node src/cli.js -p <port> -f <file> [options]

Separate components:
  node src/cli.js -p <port> --softdevice <sd.hex> --application <app.hex> [--bootloader <bl.hex>]

Analyze only (no upload):
  node src/cli.js --analyze firmware.hex

Options:
  -p, --port <port>          Serial port (e.g. /dev/ttyACM0, COM3)   [required]
  -f, --firmware <file>      Single firmware file (.bin or .hex)     [auto-detect mode]
  --softdevice <file>        SoftDevice firmware (.hex or .bin)      [3-file mode]
  --bootloader <file>        Bootloader firmware (.hex or .bin)      [3-file mode, optional]
  --application <file>       Application firmware (.hex or .bin)     [3-file mode]
  -d, --dat <file>           Init packet (.dat)                      [optional]
  -b, --baud <baud>          Baud rate (default: 115200)
  -s, --single-bank          Use single bank mode                    [optional]
  -t, --touch <baud>         Touch reset at given baud before DFU    [optional]
  -m, --mcu <model>          MCU model: 52840 (default) or 52833     [optional]
  -a, --analyze <file>       Analyze .hex file and print contents     [no upload]
  -h, --help                 Show this help
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

/**
 * Load a firmware file, supporting both .hex and .bin formats.
 * Returns { binary: Uint8Array, size: number }.
 */
function loadFirmwareFile(filePath) {
  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }
  const ext = extname(filePath).toLowerCase();
  if (ext === '.hex' || ext === '.ihx') {
    const hexData = readFileSync(filePath, 'utf-8');
    const { buf } = parseHex(hexData);
    const binary = extractBinaryFromHex(buf);
    console.log(`  ${filePath}: Intel HEX → ${binary.length} bytes binary`);
    return binary;
  } else {
    const binary = readFileSync(filePath);
    console.log(`  ${filePath}: ${binary.length} bytes binary`);
    return binary;
  }
}

async function main() {
  const opts = parseArgs();

  // ---- Analyze-only mode ----
  if (opts.analyze) {
    if (!existsSync(opts.analyze)) {
      console.error('Error: File not found: ' + opts.analyze);
      process.exit(1);
    }
    const hexData = readFileSync(opts.analyze, 'utf-8');
    const analysis = analyzeHexString(hexData);
    console.log('');
    console.log(`  📋 Analysis of: ${opts.analyze}`);
    console.log(`  ─${'─'.repeat(opts.analyze.length + 12)}`);
    console.log(`  ${analysis.toString()}`);
    console.log('');
    console.log('  Components:');
    // Show component ranges from the computed analysis (merged by component type)
    const comps = [];
    if (analysis.sdFirmwareId) {
      const size = analysis.sdSize + 0x1000; // include MBR in display range
      const start = 0;
      comps.push({ start, end: start + size - 1, label: 'SoftDevice', size });
    }
    if (analysis.appSize) {
      comps.push({ start: analysis.appStart, end: analysis.appStart + analysis.appSize - 1, label: 'Application', size: analysis.appSize });
    }
    if (analysis.blSize) {
      comps.push({ start: analysis.blStart, end: analysis.blStart + analysis.blSize - 1, label: 'Bootloader', size: analysis.blSize });
    }
    // Fallback: if no components found but regions exist, show raw regions
    if (comps.length === 0) {
      for (const r of analysis.regions) {
        const label = r.label || 'unknown';
        comps.push({ start: r.start, end: r.end, label, size: r.end - r.start + 1 });
      }
    }
    for (const c of comps) {
      console.log(`    0x${c.start.toString(16).padStart(8,'0')} - 0x${c.end.toString(16).padStart(8,'0')}  (${(c.size/1024).toFixed(1)} KB)  [${c.label}]`);
    }
    console.log('');
    process.exit(0);
  }

  // Determine mode: single .hex with auto-detect, or separate components
  const hasSeparateComponents = opts.softdevice || opts.bootloader || opts.application;
  const hasSingleFirmware = !!opts.firmware;

  if (!hasSingleFirmware && !hasSeparateComponents) {
    console.error('Error: Provide either --firmware or --softdevice/--application.');
    printHelp();
    process.exit(1);
  }

  let firmwareBinary = null;
  let sdBinary = null;
  let blBinary = null;
  let appBinary = null;
  let buf = null; // hoisted for session-building use
  let analysis = null;
  let mcu = opts.mcu || 52840;
  let sdFirmwareId = 0xfffe; // Default: any softdevice
  let sdSize = 0;
  let blSize = 0;
  let appSize = 0;
  let mode = 0;

  if (hasSeparateComponents) {
    // ---- 3-file mode ----
    console.log('Separate component mode:');

    if (opts.softdevice) {
      sdBinary = loadFirmwareFile(opts.softdevice);
      sdSize = sdBinary.length;
      mode |= DFU_UPDATE_MODE_SD;
      console.log(`  SoftDevice: ${(sdSize / 1024).toFixed(1)} KB`);
    }
    if (opts.bootloader) {
      blBinary = loadFirmwareFile(opts.bootloader);
      blSize = blBinary.length;
      mode |= DFU_UPDATE_MODE_BL;
      console.log(`  Bootloader: ${(blSize / 1024).toFixed(1)} KB`);
    }
    if (opts.application) {
      appBinary = loadFirmwareFile(opts.application);
      appSize = appBinary.length;
      mode |= DFU_UPDATE_MODE_APP;
      console.log(`  Application: ${(appSize / 1024).toFixed(1)} KB`);
    }

    // Concatenate firmware: SD + BL + APP
    const totalSize = sdSize + blSize + appSize;
    firmwareBinary = new Uint8Array(totalSize);
    let offset = 0;
    if (sdBinary) { firmwareBinary.set(sdBinary, offset); offset += sdSize; }
    if (blBinary) { firmwareBinary.set(blBinary, offset); offset += blSize; }
    if (appBinary) { firmwareBinary.set(appBinary, offset); offset += appSize; }

    console.log(`Total firmware: ${totalSize} bytes, mode: 0x${mode.toString(16)}`);

  } else {
    // ---- Single .hex mode ----
    console.log('Single firmware mode:');
    const fwPath = opts.firmware;
    const ext = extname(fwPath).toLowerCase();

    if (ext === '.hex' || ext === '.ihx') {
      // Analyze the .hex to detect components
      const hexData = readFileSync(fwPath, 'utf-8');
      const parsed = parseHex(hexData);
      buf = parsed.buf; // hoisted for session-building below
      analysis = await import('./hex-analyzer.js').then(m => m.analyzeHex(buf));

      console.log(`  ${fwPath}`);
      console.log(`  Detected: ${analysis.toString()}`);

      mcu = opts.mcu || analysis.mcu;
      sdSize = analysis.sdSize;
      blSize = analysis.blSize;
      appSize = analysis.appSize;
      sdFirmwareId = analysis.sdFirmwareId || 0xfffe;

      if (analysis.type === 'application') {
        mode = DFU_UPDATE_MODE_APP;
        console.log('  → Mode: Application only');
      } else if (analysis.type === 'sd_app') {
        mode = DFU_UPDATE_MODE_SD | DFU_UPDATE_MODE_APP;
        console.log(`  → Mode: SoftDevice + Application (SD size: ${sdSize}, APP size: ${appSize})`);
      } else if (analysis.type === 'sd_bl') {
        mode = DFU_UPDATE_MODE_SD | DFU_UPDATE_MODE_BL;
        console.log(`  → Mode: SoftDevice + Bootloader (SD size: ${sdSize}, BL size: ${blSize})`);
      } else if (analysis.type === 'sd_bl_app') {
        mode = DFU_UPDATE_MODE_SD | DFU_UPDATE_MODE_BL | DFU_UPDATE_MODE_APP;
        console.log(`  → Mode: Full (SD+BL+APP, SD: ${sdSize}, BL: ${blSize}, APP: ${appSize})`);
      } else if (analysis.type === 'softdevice') {
        mode = DFU_UPDATE_MODE_SD;
        console.log(`  → Mode: SoftDevice only (size: ${sdSize})`);
      } else if (analysis.type === 'bootloader') {
        mode = DFU_UPDATE_MODE_BL;
        console.log(`  → Mode: Bootloader only (size: ${blSize})`);
      } else {
        mode = DFU_UPDATE_MODE_APP;
        console.log('  → Mode: Application only (fallback)');
      }

      // Build firmware as concatenated [SD][BL][APP] components (no padding),
      // matching how the Python tool's nRFHex.tobinfile() works.
      // extractBinaryFromHex would include all padding between components,
      // which makes the blob far larger than sdSize+blSize+appSize.
      const sdBin = sdSize ? extractRegionBinary(buf, 0x1000, 0x1000 + sdSize - 1) : new Uint8Array(0);
      const blBin = blSize ? extractRegionBinary(buf, analysis.blStart, analysis.blStart + blSize - 1) : new Uint8Array(0);
      const appBin = appSize ? extractRegionBinary(buf, analysis.appStart, analysis.appStart + appSize - 1) : new Uint8Array(0);
      firmwareBinary = new Uint8Array(sdSize + blSize + appSize);
      let off = 0;
      if (sdBin.length) { firmwareBinary.set(sdBin, off); off += sdBin.length; }
      if (blBin.length) { firmwareBinary.set(blBin, off); off += blBin.length; }
      if (appBin.length) { firmwareBinary.set(appBin, off); off += appBin.length; }
      console.log(`  Concatenated: SD(${(sdSize/1024).toFixed(1)}K) + BL(${(blSize/1024).toFixed(1)}K) + APP(${(appSize/1024).toFixed(1)}K) = ${firmwareBinary.length} bytes`);
    } else {
      // .bin file
      firmwareBinary = readFileSync(fwPath);
      appSize = firmwareBinary.length;
      mode = DFU_UPDATE_MODE_APP;
      console.log(`  ${fwPath}: ${firmwareBinary.length} bytes binary (mode: APP)`);
    }
  }

  // Read or generate init packet
  const deviceRev = DEFAULT_DEV_REV[mcu] || 52840;
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
    console.log(`Device revision: ${deviceRev}`);
  }

  // ---- Build session plan ----
  // The bootloader cannot update SD+BL+APP in one go because updating the
  // bootloader requires a reboot. Sessions are sent sequentially:
  //   - sd_bl_app → session 1: SD+BL, session 2: APP
  //   - sd_bl      → one session: SD+BL
  //   - sd_app     → one session: SD+APP
  //   - other      → one session
  //
  // Each session opens the port, sends DFU, closes port, and waits for reboot.

  /** @type {Array<{mode:number, fw:Uint8Array, sdSize:number, blSize:number, appSize:number, label:string}>} */
  const sessions = [];

  if (analysis && analysis.type === 'sd_bl_app') {
    // Rebuild SD+BL and APP portions from the hex buf
    const sdBin = extractRegionBinary(buf, 0x1000, 0x1000 + analysis.sdSize - 1);
    const blBin = extractRegionBinary(buf, analysis.blStart, analysis.blStart + analysis.blSize - 1);
    const appBin = extractRegionBinary(buf, analysis.appStart, analysis.appStart + analysis.appSize - 1);

    const sdBlFw = new Uint8Array(analysis.sdSize + analysis.blSize);
    sdBlFw.set(sdBin, 0);
    sdBlFw.set(blBin, analysis.sdSize);

    sessions.push({
      mode: DFU_UPDATE_MODE_SD | DFU_UPDATE_MODE_BL,
      fw: sdBlFw,
      sdSize: analysis.sdSize, blSize: analysis.blSize, appSize: 0,
      label: 'SoftDevice + Bootloader',
    });
    sessions.push({
      mode: DFU_UPDATE_MODE_APP,
      fw: appBin,
      sdSize: 0, blSize: 0, appSize: analysis.appSize,
      label: 'Application',
    });
    console.log(`  Split into 2 sessions: [SD+BL] → [APP]`);
  } else {
    // Single session for all other types
    sessions.push({
      mode, fw: firmwareBinary, sdSize, blSize, appSize,
      label: analysis ? analysis.type : 'firmware',
    });
  }

  // ---- Run sessions ----

  async function runSession(session, isLast) {
    const { mode, fw, sdSize, blSize, appSize, label } = session;

    const adapter = new NodeSerialAdapter(opts.port, {
      baudRate: opts.baudRate || 115200,
      touchBaud: opts.touch || 0,
    });

    console.log(`\n--- Session: ${label} ---`);
    console.log(`Opening ${opts.port} at ${opts.baudRate || 115200} baud...`);
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
      const initPkt = generateMinimalInitPacket(fw, {
        deviceType: 0x0052,
        deviceRev: deviceRev,
        appVersion: 0xFFFFFFFF,
        softdeviceReq: [0xfffe],
      });
      console.log(`Init packet: ${initPkt.length} bytes`);

      console.log('Sending DFU start packet...');
      await transport.sendStartDfu(mode, sdSize, blSize, appSize);

      console.log('Sending init packet...');
      await transport.sendInitPacket(initPkt);

      console.log('Sending firmware...');
      await transport.sendFirmware(fw);

      console.log('Activating firmware...');
      await transport.sendActivateFirmware();

      const waitTime = transport.getActivateWaitTime();
      console.log(`Waiting ${waitTime.toFixed(1)}s for activation...`);
      await new Promise(r => setTimeout(r, waitTime * 1000));

      console.log(`✅ Session complete: ${label}`);
    } finally {
      try { await adapter.close(); } catch {}
    }
  }

  for (let i = 0; i < sessions.length; i++) {
    await runSession(sessions[i], i === sessions.length - 1);
  }

  console.log('\n✅ All firmware uploaded successfully!');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
