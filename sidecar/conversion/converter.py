"""ebook-convert wrapper (Calibre CLI)."""

import os
import subprocess

TIMEOUT = 300


def convert_format(input_path: str, output_path: str, ebook_convert_path: str) -> dict:
    if not os.path.exists(ebook_convert_path):
        raise FileNotFoundError(f"ebook-convert not found at {ebook_convert_path}")
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Source file not found: {input_path}")

    result = subprocess.run(
        [ebook_convert_path, input_path, output_path],
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
    )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-500:]
        raise RuntimeError(f"ebook-convert failed ({result.returncode}): {tail}")
    if not os.path.exists(output_path):
        raise RuntimeError("ebook-convert reported success but produced no output file")

    return {"output_path": output_path, "size_bytes": os.path.getsize(output_path)}
