"""Provider HTTP latency on the live GPU App with scanner-prepared pages (one JSON line per request).

Phases (each tagged in the output): `cold` (first request after the container has been idle), `warm` (sequential,
one page at a time), `burst` (several requests at once against the single-container, single-input provider),
`cold2` (after an idle gap longer than the scale-down window). The request is exactly what the scanner sends:
a PNG page, `textPolicy={"mode":"fusion-v1"}`, a unique Idempotency-Key and the Modal proxy-auth headers.
Records the client wall time, the status, the provider's own reported timing and, for failures, the error code.
"""

import argparse
import concurrent.futures
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

TIMEOUT_SECONDS = 700  # above the 660 s function timeout, so a stall shows as the provider's, not ours


def multipart(fields, file_field, filename, content):
    boundary = uuid.uuid4().hex
    body = b""
    for name, value in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    body += f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\nContent-Type: image/png\r\n\r\n'.encode() + content + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return boundary, body


def request(url, key_id, key_secret, path, phase):
    content = Path(path).read_bytes()
    boundary, body = multipart({"detectTitle": "false", "textPolicy": '{"mode":"fusion-v1"}'}, "page", Path(path).name, content)
    req = urllib.request.Request(
        url + "/v1/scan-page",
        data=body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Modal-Key": key_id,
            "Modal-Secret": key_secret,
            "Idempotency-Key": hashlib.sha256(f"{phase}:{path}:{uuid.uuid4()}".encode()).hexdigest(),
        },
    )
    started = time.time()
    tick = time.monotonic()
    status, payload = None, {}
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            status, payload = response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        status = error.code
        try:
            payload = json.loads(error.read())
        except Exception:  # noqa: BLE001
            payload = {}
    except Exception as error:  # noqa: BLE001
        status, payload = 0, {"clientError": type(error).__name__}
    wall = time.monotonic() - tick
    result = payload.get("result") or {}
    return {
        "phase": phase,
        "page": Path(path).name,
        "pixels": None,
        "startedAt": started,
        "wallSeconds": round(wall, 2),
        "status": status,
        "errorCode": (payload.get("error") or {}).get("code") or payload.get("code") or payload.get("clientError"),
        "timing": payload.get("timing"),
        "serviceRevision": (payload.get("engine") or {}).get("serviceRevision"),
        "directionRows": len(((result.get("lyricText") or {}).get("directionRows") or {}).get("rows") or []),
        "lyricRows": len((result.get("lyricText") or {}).get("rows") or []),
        "findings": len(result.get("crossStaffFindings") or []),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pages", type=Path, required=True, help="JSON list of PNG paths for the warm phase")
    parser.add_argument("--burst-pages", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cold-gap", type=int, default=150, help="idle seconds before a cold request")
    args = parser.parse_args()
    url = os.environ["SCANNER_OTS_HOMR_PROVIDER_URL"].rstrip("/")
    key_id, key_secret = os.environ["SCANNER_OTS_HOMR_MODAL_TOKEN_ID"], os.environ["SCANNER_OTS_HOMR_MODAL_TOKEN_SECRET"]
    pages = json.loads(args.pages.read_text())
    burst = json.loads(args.burst_pages.read_text())

    def record(row):
        with args.out.open("a") as handle:
            handle.write(json.dumps(row) + "\n")
        print(row["phase"], row["page"][:34].ljust(34), row["status"], row["wallSeconds"], "s", row.get("errorCode") or "", flush=True)

    print(f"idling {args.cold_gap}s so the container scales to zero", flush=True)
    time.sleep(args.cold_gap)
    record(request(url, key_id, key_secret, pages[0], "cold"))
    for path in pages[1:]:
        record(request(url, key_id, key_secret, path, "warm"))
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(burst)) as pool:
        for row in pool.map(lambda p: request(url, key_id, key_secret, p, "burst"), burst):
            record(row)
    print(f"idling {args.cold_gap}s again", flush=True)
    time.sleep(args.cold_gap)
    record(request(url, key_id, key_secret, pages[1], "cold2"))
    print("LATENCY_RUN_DONE", flush=True)


if __name__ == "__main__":
    main()
