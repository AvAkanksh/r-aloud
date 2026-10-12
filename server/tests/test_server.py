import io
import wave

import numpy as np
import pytest
from fastapi.testclient import TestClient

from r_aloud_server.app import app

EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health_lists_backends(client):
    r = client.get("/health")
    assert r.status_code == 200
    names = {b["name"]: b for b in r.json()["backends"]}
    assert names["kokoro"]["available"] and names["kokoro"]["loaded"]
    assert "moss" in names


def test_voices(client):
    r = client.get("/v1/voices", params={"backend": "kokoro"})
    body = r.json()
    ids = {v["id"] for v in body["voices"]}
    assert body["default"] == "af_heart" and "af_heart" in ids and "bm_george" in ids


def test_wav_speech(client):
    r = client.post("/v1/audio/speech", json={"input": "Hello there. This is a test.", "model": "kokoro"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(r.content)) as w:
        assert w.getframerate() == 24000 and w.getnchannels() == 1
        seconds = w.getnframes() / w.getframerate()
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    assert 1.0 < seconds < 6.0
    assert np.abs(samples).max() > 1000  # not silence


def test_pcm_stream_and_speed(client):
    def duration(speed):
        r = client.post("/v1/audio/speech", json={
            "input": "The quick brown fox jumps over the lazy dog.",
            "response_format": "pcm", "speed": speed, "voice": "bf_emma"})
        assert r.status_code == 200 and r.headers["x-sample-rate"] == "24000"
        assert r.headers["x-voice"] == "bf_emma"
        return len(r.content) / 2 / 24000
    assert duration(1.6) < duration(1.0) * 0.8


def test_multi_paragraph_and_symbols(client):
    r = client.post("/v1/audio/speech", json={"input": "First paragraph.\n\n***\n\nSecond one.", "response_format": "pcm"})
    assert r.status_code == 200 and len(r.content) > 24000  # > 0.5 s


@pytest.mark.parametrize("payload,code", [
    ({"input": "   "}, 400),
    ({"input": "hi", "voice": "nope"}, 400),
    ({"input": "hi", "speed": 9}, 400),
    ({"input": "x" * 6000}, 413),
])
def test_rejects_bad_input(client, payload, code):
    assert client.post("/v1/audio/speech", json=payload).status_code == code


def test_cors_allows_extensions_only(client):
    ok = client.options("/v1/audio/speech", headers={
        "Origin": EXT_ORIGIN, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"})
    assert ok.headers.get("access-control-allow-origin") == EXT_ORIGIN
    moz = client.get("/health", headers={"Origin": "moz-extension://1234-abcd"})
    assert moz.headers.get("access-control-allow-origin") == "moz-extension://1234-abcd"
    evil = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in evil.headers
    assert "x-sample-rate" in client.post("/v1/audio/speech", json={"input": "ok"},
        headers={"Origin": EXT_ORIGIN}).headers["access-control-expose-headers"].lower()


def test_split_for_streaming():
    from r_aloud_server.backends.kokoro import split_for_streaming

    pieces = split_for_streaming(
        'Short one. A much longer sentence that keeps going, with several clauses inside it; '
        'enough that streaming it in pieces makes the first audio arrive sooner.\n"Quoted!" End'
    )
    texts = [p for p, _ in pieces]
    assert texts[0] == "Short one."
    assert all(len(t) <= 120 for t in texts)
    assert '"Quoted!"' in texts and texts[-1] == "End"
    assert pieces[-1][1] == 0.0
    # Nothing lost or reordered.
    assert " ".join(texts).replace("\n", " ").split() == (
        'Short one. A much longer sentence that keeps going, with several clauses inside it; '
        'enough that streaming it in pieces makes the first audio arrive sooner. "Quoted!" End').split()


def test_local_pdf(client, tmp_path):
    pdf = tmp_path / "doc.pdf"
    pdf.write_bytes(b"%PDF-1.4\n%fake but magic is enough\n%%EOF\n")
    notpdf = tmp_path / "secret.txt"
    notpdf.write_text("private")
    h = {"X-R-Aloud": "1"}

    r = client.get("/v1/local-pdf", params={"path": str(pdf)}, headers=h)
    assert r.status_code == 200 and r.content.startswith(b"%PDF-")
    assert client.get("/v1/local-pdf", params={"path": str(pdf)}).status_code == 403  # no header
    assert client.get("/v1/local-pdf", params={"path": str(notpdf)}, headers=h).status_code == 415
    assert client.get("/v1/local-pdf", params={"path": "doc.pdf"}, headers=h).status_code == 400
    assert client.get("/v1/local-pdf", params={"path": str(tmp_path / "nope.pdf")}, headers=h).status_code == 404
    # Symlink disguised as a PDF still gets its target checked.
    link = tmp_path / "link.pdf"
    link.symlink_to(notpdf)
    assert client.get("/v1/local-pdf", params={"path": str(link)}, headers=h).status_code == 415


def test_local_pdf_preflight_blocks_websites(client):
    def preflight(origin):
        return client.options("/v1/local-pdf", headers={
            "Origin": origin, "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-r-aloud"})
    assert preflight("https://evil.example").status_code == 400
    assert preflight("moz-extension://1234-abcd").status_code == 200


def test_espeak_data_path_survives_deep_install_dirs(tmp_path, monkeypatch):
    # espeak-ng silently ignores data paths longer than its 160-byte buffer.
    import shutil

    import espeakng_loader
    from r_aloud_server.backends import kokoro

    deep = tmp_path / ("nested-" * 30) / "espeak-ng-data"
    shutil.copytree(espeakng_loader.get_data_path(), deep)
    monkeypatch.setattr(espeakng_loader, "get_data_path", lambda: str(deep))
    monkeypatch.setattr(kokoro, "DATA_DIR", tmp_path / "short")
    path = kokoro._espeak_data_path()
    assert len(path) <= kokoro.ESPEAK_PATH_MAX
    assert (tmp_path / "short" / "espeak-ng-data" / "phontab").is_file()
    assert kokoro._espeak_data_path() == path  # reused, not recopied
