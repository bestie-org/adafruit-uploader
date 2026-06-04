/**
 * nRF52 Serial DFU — barrel export.
 *
 * All public API surfaces are exported from this module.
 */

export { calcCrc16 } from './crc16.js';
export {
  uint16ToBytes,
  uint32ToBytes,
  int32ToBytes,
  int16ToBytes,
  slipPartsToFourBytes,
  slipEncodeEscChars,
  slipDecodeEscChars,
  toHexString,
} from './util.js';
export {
  NordicSemiException,
  NotImplementedException,
  InvalidArgumentException,
  MissingArgumentException,
  IllegalStateException,
} from './exceptions.js';
export { HexType, FirmwareKeys, PacketField, INIT_PACKET_USES_CRC16, INIT_PACKET_USES_HASH, INIT_PACKET_EXT_USES_ECDS } from './model.js';
export {
  DfuTransportSerial,
  DfuTransport,
  DfuEvent,
  HciPacket,
  DFU_INIT_PACKET,
  DFU_START_PACKET,
  DFU_DATA_PACKET,
  DFU_STOP_DATA_PACKET,
  DFU_UPDATE_MODE_NONE,
  DFU_UPDATE_MODE_SD,
  DFU_UPDATE_MODE_BL,
  DFU_UPDATE_MODE_APP,
  DEFAULT_BAUD_RATE,
} from './dfu-transport-serial.js';
export {
  parseHex,
  extractBinaryFromHex,
  loadFirmware,
  HexError,
  HexRecordError,
  HexChecksumError,
} from './intelhex.js';
export { NodeSerialAdapter } from './node-serial-adapter.js';
export { WebSerialAdapter } from './web-serial-adapter.js';
