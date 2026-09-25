"""The dispatch loop's promise: every request gets a frame back, or stderr says why."""

import main


def _capture(monkeypatch):
    sent = []
    monkeypatch.setattr(main, "send", lambda frame: sent.append(frame))
    return sent


def test_non_object_request_is_reported_not_swallowed(monkeypatch, capsys):
    sent = _capture(monkeypatch)
    main.handle_request(["not", "an", "object"])
    assert sent == []
    assert "not a JSON-RPC object" in capsys.readouterr().err


def test_unknown_method_still_replies_with_error(monkeypatch):
    sent = _capture(monkeypatch)
    main.handle_request({"id": 7, "method": "nope"})
    assert sent[0]["id"] == 7
    assert "Unknown method" in sent[0]["error"]["message"]
