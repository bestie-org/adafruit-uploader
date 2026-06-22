#!/usr/bin/env python3
"""Extract board data from Adafruit nRF52 Bootloader board definitions.

Reads board.mk and board.h from each board directory under the boards/ path,
produces a board_db.json array of board objects.

Usage:
    python3 extract_board_data.py [BOARDS_DIR] [OUTPUT_FILE]
"""

import json
import re
import sys
from pathlib import Path

MCU_MAP = {
    "nrf52": "nrf52832",
    "nrf52833": "nrf52833",
    "nrf52840": "nrf52840",
}


def parse_mk(filepath: Path) -> str | None:
    """Extract MCU_SUB_VARIANT from board.mk, mapped through MCU_MAP."""
    with open(filepath) as f:
        for line in f:
            m = re.match(r"^MCU_SUB_VARIANT\s*=\s*(\S+)", line)
            if m:
                variant = m.group(1)
                return MCU_MAP.get(variant, variant)
    return None


def parse_h(filepath: Path) -> tuple[str | None, ...]:
    """Extract USB/PID/UF2 defines from board.h.

    Returns (vid, uf2_pid, cdc_pid, product_name, board_id) as raw strings.
    """
    with open(filepath) as f:
        content = f.read()

    def get_define(name: str) -> str | None:
        m = re.search(
            rf"^#define\s+{name}\s+(.+?)(?:\s*//.*)?$", content, re.MULTILINE
        )
        return m.group(1).strip() if m else None

    return (
        get_define("USB_DESC_VID"),
        get_define("USB_DESC_UF2_PID"),
        get_define("USB_DESC_CDC_ONLY_PID"),
        get_define("UF2_PRODUCT_NAME"),
        get_define("UF2_BOARD_ID"),
    )


def parse_hex(s: str | None) -> int | None:
    """Parse a C hex literal (e.g. '0x239A') to int."""
    if s is None:
        return None
    return int(s, 0)


def parse_str(s: str | None) -> str | None:
    """Strip surrounding double-quotes from a C string literal."""
    if s is None:
        return None
    s = s.strip()
    if s.startswith('"') and s.endswith('"'):
        return s[1:-1]
    return s


def process_board(board_dir: Path) -> dict | None:
    """Process one board directory. Returns a dict or None if skipped."""
    mk_file = board_dir / "board.mk"
    h_file = board_dir / "board.h"

    if not mk_file.exists() or not h_file.exists():
        return None

    mcu = parse_mk(mk_file)
    if mcu is None:
        return None

    vid_raw, uf2_pid_raw, cdc_pid_raw, product_name_raw, board_id_raw = parse_h(
        h_file
    )

    # Skip rules
    if vid_raw is None:
        return None
    if uf2_pid_raw is None and cdc_pid_raw is None:
        return None

    vid = parse_hex(vid_raw)
    uf2_pid = parse_hex(uf2_pid_raw)
    cdc_pid = parse_hex(cdc_pid_raw)
    product_name = parse_str(product_name_raw) or ""
    board_id = parse_str(board_id_raw) or ""

    # Build pids array — deduplicate when both PIDs are equal
    pids: list[int] = []
    if uf2_pid is not None and cdc_pid is not None and uf2_pid == cdc_pid:
        pids = [uf2_pid]
    else:
        if uf2_pid is not None:
            pids.append(uf2_pid)
        if cdc_pid is not None:
            pids.append(cdc_pid)

    return {
        "bootloader_name": board_dir.name,
        "board_id": board_id,
        "product_name": product_name,
        "mcu": mcu,
        "usb_vid": vid,
        "pids": pids,
    }



USAGE = """Usage: extract_board_data.py BOOTLOADER_REPO [OUTPUT_FILE]

  BOOTLOADER_REPO  Path to the Adafruit_nRF52_Bootloader repository root.
  OUTPUT_FILE      Where to write the JSON array (default: board_db.json)."""

def die(msg: str) -> None:
    print(f"Error: {msg}\n{USAGE}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    if len(sys.argv) < 2:
        die("missing BOOTLOADER_REPO argument")
    if len(sys.argv) > 3:
        die("too many arguments")

    repo_dir = Path(sys.argv[1])
    boards_dir = repo_dir / "src" / "boards"
    if not boards_dir.is_dir():
        die(f"not a bootloader repo (missing src/boards/): {repo_dir}")

    output_file = sys.argv[2] if len(sys.argv) > 2 else "board_db.json"

    results: list[dict] = []
    for board_dir in sorted(boards_dir.iterdir()):
        if not board_dir.is_dir():
            continue
        entry = process_board(board_dir)
        if entry is not None:
            results.append(entry)

    if not results:
        die(
            f"no board definitions found in {boards_dir} "
            f"(expected subdirectories with board.mk and board.h)"
        )

    with open(output_file, "w") as f:
        json.dump(results, f, indent=2)
        f.write("\n")

    print(f"Wrote {len(results)} boards to {output_file}")


if __name__ == "__main__":
    main()
