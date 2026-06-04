# nRF52 DFU Web Uploader

JavaScript port of [Adafruit_nRF52_nrfutil](https://github.com/adafruit/Adafruit_nRF52_nrfutil) — serial DFU for Adafruit Feather nRF52840 (and other nRF52 boards with the [Adafruit nRF52 bootloader](https://github.com/adafruit/adafruit_nRF52_bootloader)).

Works from the command line and in the browser via Web Serial API.

## Usage

### Command line

```bash
npm install
node src/cli.js -p /dev/ttyACM0 -f firmware.hex
```

### Browser (Web Serial)

```bash
npm run serve
# → http://localhost:3000
```

Connect your board, pick a `.hex` file, upload. The page uses the same code under the hood — just the transport swaps from `node-serial-adapter` to `web-serial-adapter`.

### In a Node.js project

```js
import { parseHex, extractBinaryFromHex } from './src/intelhex.js';
import { generateMinimalInitPacket } from './src/init-packet.js';
import { DfuTransportSerial, DFU_UPDATE_MODE_APP } from './src/dfu-transport-serial.js';
```

## Project structure

```
index.html     ← browser DFU uploader
src/
├── cli.js                   ← CLI entry point
├── dfu-transport-serial.js  ← DFU protocol (HCI/SLIP/CRC16)
├── intelhex.js              ← Intel HEX parser + binary extractor
├── init-packet.js           ← Auto-generate .dat init packets
├── node-serial-adapter.js   ← Node.js serial adapter
├── web-serial-adapter.js    ← Web Serial API adapter
└── server.js                ← Dev server for local testing
```

## License

BSD-3-Clause (same as the original Nordic Semiconductor and Adafruit projects).
