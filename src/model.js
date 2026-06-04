/**
 * Data model constants for nRF5x DFU.
 *
 * Ported from nordicsemi/dfu/model.py and nordicsemi/dfu/init_packet.py
 */

/** Firmware type identifiers */
export const HexType = Object.freeze({
  SOFTDEVICE: 1,
  BOOTLOADER: 2,
  SD_BL: 3,
  APPLICATION: 4,
});

/** Keys used in the firmware data dictionary */
export const FirmwareKeys = Object.freeze({
  ENCRYPT: 1,
  FIRMWARE_FILENAME: 2,
  BIN_FILENAME: 3,
  DAT_FILENAME: 4,
  INIT_PACKET_DATA: 5,
  SD_SIZE: 6,
  BL_SIZE: 7,
});

/** Init packet extension identifiers */
export const INIT_PACKET_USES_CRC16 = 0;
export const INIT_PACKET_USES_HASH = 1;
export const INIT_PACKET_EXT_USES_ECDS = 2;

/** Fields that can appear in an init packet */
export const PacketField = Object.freeze({
  DEVICE_TYPE: 1,
  DEVICE_REVISION: 2,
  APP_VERSION: 3,
  REQUIRED_SOFTDEVICES_ARRAY: 4,
  OPT_DATA: 5,
  NORDIC_PROPRIETARY_OPT_DATA_EXT_PACKET_ID: 6,
  NORDIC_PROPRIETARY_OPT_DATA_FIRMWARE_LENGTH: 7,
  NORDIC_PROPRIETARY_OPT_DATA_FIRMWARE_HASH: 8,
  NORDIC_PROPRIETARY_OPT_DATA_FIRMWARE_CRC16: 9,
  NORDIC_PROPRIETARY_OPT_DATA_INIT_PACKET_ECDS: 10,
});
