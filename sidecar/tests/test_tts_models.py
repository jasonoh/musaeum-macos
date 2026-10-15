"""Model acquisition: pinned, verified, resumable-by-restart, cancelable, and quiet about failure."""

import hashlib
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from tts import models
from tts.models import ModelFile, ModelProblem

A = b"a" * 50_000
B = b"b" * 30_000


def sha(b):
    return hashlib.sha256(b).hexdigest()


FILES = (ModelFile("a.bin", len(A), sha(A)), ModelFile("b.bin", len(B), sha(B)))


class QuietServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer.server_bind calls socket.getfqdn(), which can stall ~35s on a slow resolver.
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


@pytest.fixture
def server():
    served = {"a.bin": A, "b.bin": B}
    hits = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = served.get(self.path.lstrip("/"))
            hits.append(self.path)
            if body is None:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # keep pytest output clean
            pass

    httpd = QuietServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.05), daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", served, hits
    httpd.shutdown()
    httpd.server_close()


def run(tmp_path, base, **kw):
    frames = []
    result = models.download_models(
        str(tmp_path / "m"),
        job_id=kw.pop("job_id", "job-1"),
        notify=lambda method, params: frames.append((method, params)),
        files=FILES,
        base_url=base,
        chunk=4096,
        **kw,
    )
    return result, frames


def test_the_pinned_files_match_the_spec():
    assert [f.name for f in models.FILES] == ["kokoro-v1.0.int8.onnx", "voices-v1.0.bin"]
    assert models.FILES[0].size == 92_361_271 and models.FILES[1].size == 28_214_398
    assert models.FILES[0].sha256 == "6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb"
    assert models.FILES[1].sha256 == "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"
    assert models.TOTAL_BYTES == 92_361_271 + 28_214_398


def test_status_with_nothing_downloaded(tmp_path):
    s = models.model_status(str(tmp_path / "nope"), FILES)
    assert s == {"ready": False, "missing": ["a.bin", "b.bin"], "total_bytes": len(A) + len(B)}


def test_download_verifies_and_reports_progress(tmp_path, server):
    base, _, _ = server
    result, frames = run(tmp_path, base)
    assert result == {"status": "ready"}
    assert models.model_status(str(tmp_path / "m"), FILES)["ready"] is True
    assert frames and all(m == "tts_model_progress" for m, _ in frames)
    last = frames[-1][1]
    assert last["completed"] == last["total"] == len(A) + len(B) and last["job_id"] == "job-1"
    models.verify(str(tmp_path / "m"), FILES)  # does not raise


def test_a_good_file_already_on_disk_is_not_fetched_again(tmp_path, server):
    base, _, hits = server
    run(tmp_path, base)
    hits.clear()
    result, _ = run(tmp_path, base, job_id="job-2")
    assert result == {"status": "ready"} and hits == []


def test_a_corrupted_file_on_disk_is_replaced(tmp_path, server):
    base, _, hits = server
    run(tmp_path, base)
    (tmp_path / "m" / "a.bin").write_bytes(b"x" * len(A))  # right size, wrong bytes
    with pytest.raises(ModelProblem, match="damaged"):
        models.verify(str(tmp_path / "m"), FILES)
    hits.clear()
    result, _ = run(tmp_path, base, job_id="job-3")
    assert result == {"status": "ready"} and hits == ["/a.bin"]
    models.verify(str(tmp_path / "m"), FILES)


def test_a_server_that_sends_the_wrong_bytes_leaves_nothing_behind(tmp_path, server):
    base, served, _ = server
    served["a.bin"] = b"z" * len(A)
    result, _ = run(tmp_path, base)
    assert result["status"] == "failed" and "a.bin" in result["error"]
    assert sorted(p.name for p in (tmp_path / "m").iterdir()) == []  # no a.bin, no a.bin.part


def test_a_missing_file_is_a_failed_result_not_a_raise(tmp_path, server):
    base, served, _ = server
    del served["b.bin"]
    result, _ = run(tmp_path, base)
    assert result["status"] == "failed"
    assert (tmp_path / "m" / "a.bin").is_file()  # the good file is kept
    assert not (tmp_path / "m" / "b.bin.part").exists()


def test_a_stale_part_file_from_a_killed_run_does_not_wedge_the_next(tmp_path, server):
    base, _, _ = server
    (tmp_path / "m").mkdir()
    (tmp_path / "m" / "a.bin.part").write_bytes(b"half")
    result, _ = run(tmp_path, base)
    assert result == {"status": "ready"}
    assert not (tmp_path / "m" / "a.bin.part").exists()


def test_cancel_stops_the_download_and_removes_the_part(tmp_path, server):
    base, _, _ = server
    frames = []

    def notify(method, params):
        frames.append(params)
        models.cancel_download("job-9")

    result = models.download_models(
        str(tmp_path / "m"), job_id="job-9", notify=notify, files=FILES, base_url=base, chunk=1024
    )
    assert result == {"status": "cancelled"}
    assert not list((tmp_path / "m").glob("*.part"))
    assert not (tmp_path / "m" / "a.bin").exists()


def test_a_cancel_that_arrives_before_the_job_starts_still_sticks(tmp_path, server):
    base, _, hits = server
    models.cancel_download("job-early")
    result, _ = run(tmp_path, base, job_id="job-early")
    assert result == {"status": "cancelled"} and hits == []


def test_it_writes_only_under_the_model_directory(tmp_path, server):
    base, _, _ = server
    run(tmp_path, base)
    assert {p.name for p in tmp_path.iterdir()} == {"m"}
