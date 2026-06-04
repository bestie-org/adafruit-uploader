# Project rules for AI agents

## Golden rules

1. **Do not commit to git without asking the user first.** No `git commit`, no `git push`, nothing.
2. **The board has a ~60 second DFU window.** After entering DFU mode, the bootloader will time out and boot into the application firmware, making `/dev/ttyACM0` disappear. If you need to re-test, ask the user to re-enter DFU mode (double-tap reset, or hold DFU + tap reset).

## Project overview

JavaScript nRF52 serial DFU library — port of Adafruit_nRF52_nrfutil to run in Node.js and the browser (Web Serial API).

## Key files

| File | Purpose |
|------|---------|
| `src/dfu-transport-serial.js` | Core DFU protocol: HCI packets, SLIP framing, DFU state machine |
| `src/intelhex.js` | Intel HEX parser + binary extractor |
| `src/init-packet.js` | Auto-generate .dat init packets for Adafruit bootloader |
| `src/node-serial-adapter.js` | Node.js serial port adapter |
| `src/web-serial-adapter.js` | Browser Web Serial API adapter |
| `src/cli.js` | Command-line entry point |
| `src/crc16.js` | CRC16 algorithm |
| `src/util.js` | SLIP encode/decode, byte conversions |
| `src/test-protocol.js` | Protocol unit tests (run with `node src/test-protocol.js`) |
| `package.json` | Dependencies (`serialport` npm package) |

## Hardware

- **Board:** Adafruit Feather nRF52840 Express
- **Bootloader:** https://github.com/adafruit/adafruit_nrf52_bootloader (serial DFU)
- **Port:** `/dev/ttyACM0` (symlink at `/dev/serial/by-id/usb-Adafruit_Industries_Feather_nRF52840_Express_*-if00`)
- **DFU mode entry:** Double-tap reset button, or hold DFU + tap reset
- **Protocol:** 115200 baud, SLIP-framed HCI packets, CRC16 integrity

## Testing

```bash
node src/test-protocol.js
node src/cli.js -p /dev/ttyACM0 -f firmware.hex
```
