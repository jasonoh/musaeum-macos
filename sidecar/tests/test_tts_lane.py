"""Speech has its own lane: a saturated shared pool must not make the voice stall (spec D3, AC7)."""

import threading
import time

import main


def _wait_for(sent, n=1, timeout=2.0):
    end = time.time() + timeout
    while len(sent) < n and time.time() < end:
        time.sleep(0.01)


def test_synthesis_is_answered_while_the_shared_pool_is_saturated(monkeypatch):
    sent = []
    monkeypatch.setattr(main, "send", sent.append)
    monkeypatch.setitem(main.METHODS, "tts_synthesize", lambda p: {"ok": True})
    gate = threading.Event()
    blockers = [main.POOL.submit(gate.wait) for _ in range(4)]
    try:
        main.dispatch({"id": 1, "method": "tts_synthesize", "params": {}})
        _wait_for(sent)
        assert sent and sent[0]["id"] == 1 and sent[0]["result"] == {"ok": True}
    finally:
        gate.set()
        for b in blockers:
            b.result(5)


def test_an_ordinary_method_does_queue_behind_the_saturated_pool(monkeypatch):
    # The control: without this, the test above would pass even if every method had its own lane.
    sent = []
    monkeypatch.setattr(main, "send", sent.append)
    monkeypatch.setitem(main.METHODS, "ordinary", lambda p: {"ok": True})
    gate = threading.Event()
    blockers = [main.POOL.submit(gate.wait) for _ in range(4)]
    try:
        main.dispatch({"id": 2, "method": "ordinary", "params": {}})
        time.sleep(0.2)
        assert sent == []
    finally:
        gate.set()
        for b in blockers:
            b.result(5)
    _wait_for(sent)
    assert sent and sent[0]["id"] == 2


def test_lane_for_tolerates_a_request_that_is_not_an_object():
    assert main.lane_for(["not", "an", "object"]) is main.POOL
    assert main.lane_for({"method": "tts_synthesize"}) is main.TTS_POOL
    assert main.lane_for({}) is main.POOL


def test_the_four_speech_methods_are_registered():
    for name in ("tts_synthesize", "tts_model_status", "tts_download_model", "tts_cancel_download"):
        assert name in main.METHODS


def test_the_status_method_reads_the_model_dir_param(monkeypatch, tmp_path):
    out = main.METHODS["tts_model_status"]({"model_dir": str(tmp_path)})
    assert out["ready"] is False and out["missing"]


def test_status_and_cancel_are_answered_while_the_shared_pool_is_saturated(monkeypatch):
    sent = []
    monkeypatch.setattr(main, "send", sent.append)
    monkeypatch.setitem(main.METHODS, "tts_model_status", lambda p: {"ready": True})
    monkeypatch.setitem(main.METHODS, "tts_cancel_download", lambda p: {"cancelled": True})
    gate = threading.Event()
    blockers = [main.POOL.submit(gate.wait) for _ in range(4)]
    try:
        main.dispatch({"id": 1, "method": "tts_model_status", "params": {}})
        main.dispatch({"id": 2, "method": "tts_cancel_download", "params": {}})
        _wait_for(sent, n=2)
        assert {m["id"] for m in sent} == {1, 2}
    finally:
        gate.set()
        for b in blockers:
            b.result(5)


def test_the_download_stays_on_the_shared_pool():
    assert main.lane_for({"method": "tts_download_model"}) is main.POOL


def test_the_control_lane_is_not_the_speech_lane():
    assert main.lane_for({"method": "tts_model_status"}) is main.CONTROL_POOL
    assert main.lane_for({"method": "tts_synthesize"}) is main.TTS_POOL
    assert main.CONTROL_POOL is not main.TTS_POOL
