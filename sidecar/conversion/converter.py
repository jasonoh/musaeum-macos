"""EPUB → AZW3, in-house: the one conversion the app asks for (Kindle sends).

The writer is `conversion/azw3/`; this module runs it in a child process (see
`conversion/azw3/run.py`) and keeps the RPC contract the Calibre wrapper had:
`{output_path, size_bytes}` back, an exception with a reason when it cannot.
"""

import json
import os
import subprocess
import sys

TIMEOUT = 300
SIDECAR_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def convert_format(input_path: str, output_path: str, ebook_convert_path: str | None = None) -> dict:
    """Convert an EPUB to an AZW3 beside it.

    `ebook_convert_path` is accepted and ignored: the Electron side still sends it
    until the Calibre plumbing is removed there (spec slice 3).
    """
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Source file not found: {input_path}")
    if not input_path.lower().endswith(".epub") or not output_path.lower().endswith(".azw3"):
        raise ValueError("only EPUB to AZW3 conversion is supported")

    temp = output_path + ".tmp"
    if os.path.exists(temp):
        os.remove(temp)  # left by an earlier attempt that was killed mid-write
    try:
        result = subprocess.run(
            [sys.executable, "-m", "conversion.azw3.run", input_path, output_path],
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
            cwd=SIDECAR_ROOT,
        )
    except subprocess.TimeoutExpired:
        _remove(temp)
        raise RuntimeError(f"conversion timed out after {TIMEOUT} seconds") from None
    if result.returncode != 0:
        _remove(temp)
        lines = [line for line in (result.stderr or "").splitlines() if line.strip()]
        reason = lines[-1].removeprefix("error: ") if lines else f"exit status {result.returncode}"
        raise RuntimeError(f"conversion failed: {reason}")
    if not os.path.exists(output_path):
        raise RuntimeError("conversion reported success but produced no output file")

    report = json.loads(result.stdout.strip().splitlines()[-1])
    return {"output_path": output_path, "size_bytes": report["size_bytes"], "warnings": report["warnings"]}


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
