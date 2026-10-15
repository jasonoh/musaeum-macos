"""The speech model's files (spec D4): pinned by size and sha256, downloaded on first use.

They come from the `thewh1teagle/kokoro-onnx` release `model-files-v1.0` into
`userData/tts-models/` — the caller passes that directory in, so this module reads no
configuration and is decided without Electron. They are *not* in the DMG: 120 MB would
more than double it for a feature a person may never open. The hashes are the hashes of
the files Jason's listening test used on 2026-10-15, so the voices he approved are the
voices this pins.
"""

from __future__ import annotations

import hashlib
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import requests

from .errors import TtsError

RELEASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"


@dataclass(frozen=True)
class ModelFile:
    name: str
    size: int
    sha256: str


FILES = (
    ModelFile(
        "kokoro-v1.0.int8.onnx",
        92_361_271,
        "6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb",
    ),
    ModelFile(
        "voices-v1.0.bin",
        28_214_398,
        "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    ),
)
MODEL_FILE = FILES[0].name
VOICES_FILE = FILES[1].name
TOTAL_BYTES = sum(f.size for f in FILES)


class ModelProblem(TtsError):
    """The model is absent or damaged."""


class _Cancelled(Exception):
    pass


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def model_status(model_dir: str, files: tuple[ModelFile, ...] = FILES) -> dict:
    """Cheap by design — existence and size only; `verify` is the one that hashes."""
    base = Path(model_dir)
    missing = [
        f.name for f in files if not (base / f.name).is_file() or (base / f.name).stat().st_size != f.size
    ]
    return {"ready": not missing, "missing": missing, "total_bytes": sum(f.size for f in files)}


# (path, size, mtime_ns) → verified. A model is hashed once per process, not once per sentence.
_verified: set[tuple[str, int, int]] = set()


def verify(model_dir: str, files: tuple[ModelFile, ...] = FILES) -> None:
    base = Path(model_dir)
    for f in files:
        path = base / f.name
        if not path.is_file():
            raise ModelProblem("The voice is not downloaded yet")
        st = path.stat()
        key = (str(path), st.st_size, st.st_mtime_ns)
        if key in _verified:
            continue
        if st.st_size != f.size or _sha256(path) != f.sha256:
            raise ModelProblem("The voice files are damaged — download them again")
        _verified.add(key)


_cancels: dict[str, threading.Event] = {}
_cancels_lock = threading.Lock()


def _event(job_id: str) -> threading.Event:
    with _cancels_lock:
        return _cancels.setdefault(job_id, threading.Event())


def cancel_download(job_id: str) -> dict:
    # Job ids must be unique per download: a cancel arriving after the job finished leaves an entry that would cancel a reused id.
    """Safe before the job starts: the event is created by whichever side arrives first."""
    _event(job_id).set()
    return {"cancelled": True}


def download_models(
    model_dir: str,
    *,
    job_id: str,
    notify: Callable[[str, dict], None],
    files: tuple[ModelFile, ...] = FILES,
    base_url: str = RELEASE_URL,
    chunk: int = 1 << 16,
) -> dict:
    cancel = _event(job_id)
    base = Path(model_dir)
    total = sum(f.size for f in files)
    done = 0
    part: Path | None = None
    try:
        if cancel.is_set():
            raise _Cancelled
        base.mkdir(parents=True, exist_ok=True)
        for f in files:
            dest = base / f.name
            if dest.is_file() and dest.stat().st_size == f.size and _sha256(dest) == f.sha256:
                done += f.size
                continue
            part = dest.with_name(dest.name + ".part")
            h = hashlib.sha256()
            got = 0
            last = 0
            step = max(total // 100, 1)
            with requests.get(f"{base_url}/{f.name}", stream=True, timeout=30) as r, open(part, "wb") as out:
                r.raise_for_status()
                for block in r.iter_content(chunk):
                    if cancel.is_set():
                        raise _Cancelled
                    out.write(block)
                    h.update(block)
                    got += len(block)
                    if got - last >= step or got == f.size:
                        last = got
                        notify("tts_model_progress", {"job_id": job_id, "file": f.name, "completed": done + got, "total": total})
            if got != f.size or h.hexdigest() != f.sha256:
                raise ModelProblem(f"{f.name} did not download correctly — try again")
            os.replace(part, dest)
            part = None
            done += f.size
        return {"status": "ready"}
    except _Cancelled:
        return {"status": "cancelled"}
    except (requests.RequestException, OSError, ModelProblem) as exc:
        return {"status": "failed", "error": str(exc)}
    finally:
        if part is not None:
            part.unlink(missing_ok=True)
        # A leftover .part from a *previous*, killed run for a file we skipped is harmless;
        # one for a file we fetched was replaced above. Nothing else is cleaned.
        with _cancels_lock:
            _cancels.pop(job_id, None)
