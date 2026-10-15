"""Closing stdin right after a request must still answer it (the pools drain before shutdown)."""

import json
import subprocess
import sys
from pathlib import Path

SIDECAR = Path(__file__).resolve().parents[1]


def test_requests_piped_then_stdin_closed_are_all_answered():
    lines = [
        {"id": "a", "method": "tts_model_status", "params": {"model_dir": "/nonexistent"}},
        {"id": "b", "method": "tts_synthesize", "params": {"model_dir": "/nonexistent", "text": "Hello."}},
    ]
    proc = subprocess.run(
        [sys.executable, "main.py"],
        cwd=SIDECAR,
        input="".join(json.dumps(x) + "\n" for x in lines),
        capture_output=True,
        text=True,
        timeout=60,
    )
    frames = {f["id"]: f for f in map(json.loads, proc.stdout.splitlines())}
    assert frames["a"]["result"]["ready"] is False
    # The wording depends on whether the espeak bundle is present (phonemizing precedes the model check);
    # this test is about the EOF drain: "b" is answered, as a sentence, not dropped.
    assert frames["b"]["error"] is None
    assert isinstance(frames["b"]["result"]["error"], str) and frames["b"]["result"]["error"]
