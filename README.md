# nRF52 DFU Web Uploader

JavaScript port of [Adafruit_nRF52_nrfutil](https://github.com/adafruit/Adafruit_nRF52_nrfutil) — serial DFU for Adafruit Feather nRF52840 (and other nRF52 boards with the [Adafruit nRF52 bootloader](https://github.com/adafruit/adafruit_nRF52_bootloader)).

Works from the command line and in the browser via Web Serial API.

## Features

- **Single .hex with auto-detection** — upload a combined softdevice+application .hex and the tool detects what's inside
- **3-file mode** — upload softdevice, bootloader, and application as separate files
- **Auto-detect MCU** (nRF52840 / nRF52833) from firmware address ranges
- **Detect SoftDevice** presence, type, and version from the magic number in the firmware image
- **Web UI** — browser-based uploader with Web Serial API
- **CLI** — command-line uploader for scripting

## Usage

### Command line

```bash
npm install
```

**Single .hex (auto-detect):**
```bash
node src/cli.js -p /dev/ttyACM0 -f merged.hex
```

**Separate components:**
```bash
node src/cli.js -p /dev/ttyACM0 --softdevice s140.hex --application app.hex
node src/cli.js -p /dev/ttyACM0 --softdevice sd.hex --bootloader bl.hex --application app.hex
```

**Specify MCU model (optional, auto-detected from .hex):**
```bash
node src/cli.js -p /dev/ttyACM0 -f firmware.hex --mcu 52833
```

### Browser (Web Serial)

```bash
npm run serve
# → http://localhost:3000
```

The web UI has two modes:
1. **Single .hex (auto-detect)** — pick a `.hex` file, the tool analyzes it and shows detected components
2. **3-file mode** — upload softdevice, bootloader, and application separately

### In a Node.js project

```js
import { analyzeHexString } from './src/hex-analyzer.js';
import { parseHex, extractBinaryFromHex, extractRegionBinary } from './src/intelhex.js';
import { generateMinimalInitPacket } from './src/init-packet.js';
import { DfuTransportSerial, DFU_UPDATE_MODE_APP } from './src/dfu-transport-serial.js';

// Analyze a .hex file
const hexData = fs.readFileSync('firmware.hex', 'utf-8');
const analysis = analyzeHexString(hexData);
console.log(analysis.toString());
// → "MCU: nRF52840 | SD: S140 v7.2 | APP: 87 KB at 0x27000 | Type: sd_app"
```

## Auto-Detection Logic

The `hex-analyzer.js` module detects firmware components by:

1. **SoftDevice**: Looks for the Nordic magic number `0x51B1E5DB` at the info structure (`0x00003004`). Extracts the firmware ID and version from the structure to identify which SoftDevice is present (S140, S312, etc.). Uses a lookup table of known SoftDevice sizes to determine the SD region boundary.

2. **Bootloader**: Detects data at high flash addresses (≥ `0xE0000` for nRF52840, ≥ `0x70000` for nRF52833).

3. **Application**: Everything between the SoftDevice end and Bootloader start.

4. **MCU model**: Determined from the maximum address in the firmware — nRF52840 has 1MB flash, nRF52833 has 512KB.

## Project structure

```
index.html     ← browser DFU uploader (single & 3-file modes)
src/
├── hex-analyzer.js          ← Auto-detect .hex contents (SD/BL/APP)
├── cli.js                   ← CLI entry point
├── dfu-transport-serial.js  ← DFU protocol (HCI/SLIP/CRC16)
├── intelhex.js              ← Intel HEX parser + binary extractor
├── init-packet.js           ← Auto-generate .dat init packets
├── node-serial-adapter.js   ← Node.js serial adapter
├── web-serial-adapter.js    ← Web Serial API adapter
├── server.js                ← Dev server for local testing
└── index.js                 ← Barrel exports
```

## License

BSD-3-Clause (same as the original Nordic Semiconductor and Adafruit projects).
