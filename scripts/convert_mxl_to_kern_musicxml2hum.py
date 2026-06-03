#!/usr/bin/env python3
"""Convert compressed MusicXML (.mxl) files to Humdrum kern with musicxml2hum."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mxl-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--musicxml2hum", default="musicxml2hum")
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    parser.add_argument("--limit", type=int, default=0)
    return parser.parse_args()


def mxl_rootfile_name(zf: zipfile.ZipFile) -> str:
    container = zf.read("META-INF/container.xml")
    root = ET.fromstring(container)
    for elem in root.iter():
        if elem.tag.rsplit("}", 1)[-1] == "rootfile":
            full_path = elem.attrib.get("full-path")
            if full_path:
                return full_path
    raise ValueError("missing rootfile in META-INF/container.xml")


def output_name(mxl_dir: Path, src: Path) -> str:
    rel = src.relative_to(mxl_dir)
    parts = [part.replace("__", "_") for part in rel.with_suffix("").parts]
    return "__".join(parts) + ".kern"


def convert_one(task: tuple[str, str, str, str]) -> dict[str, object]:
    src_s, mxl_dir_s, out_dir_s, binary = task
    src = Path(src_s)
    mxl_dir = Path(mxl_dir_s)
    out = Path(out_dir_s) / output_name(mxl_dir, src)
    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        with zipfile.ZipFile(src) as zf:
            rootfile = mxl_rootfile_name(zf)
            xml_bytes = zf.read(rootfile)

        with tempfile.NamedTemporaryFile(suffix=".musicxml") as tmp:
            tmp.write(xml_bytes)
            tmp.flush()
            proc = subprocess.run(
                [binary, tmp.name],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
            )

        if proc.returncode != 0:
            return {
                "src": str(src),
                "ok": False,
                "reason": f"musicxml2hum_exit_{proc.returncode}",
                "stderr": proc.stderr[-1000:],
            }
        text = proc.stdout.strip()
        if not text:
            return {"src": str(src), "ok": False, "reason": "empty_output"}
        out.write_text(text + "\n", encoding="utf-8")
        return {"src": str(src), "ok": True, "out": str(out), "chars": len(text)}
    except Exception as exc:
        return {
            "src": str(src),
            "ok": False,
            "reason": f"{type(exc).__name__}:{exc}",
        }


def main() -> None:
    args = parse_args()
    mxl_dir = Path(args.mxl_dir).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    paths = sorted(mxl_dir.rglob("*.mxl"))
    if args.limit:
        paths = paths[: args.limit]

    tasks = [(str(path), str(mxl_dir), str(out_dir), args.musicxml2hum) for path in paths]
    summary: dict[str, object] = {"inputs": len(tasks), "ok": 0, "failed": 0, "reasons": {}}
    failures_path = out_dir / "conversion-failures.jsonl"
    with failures_path.open("w", encoding="utf-8") as failures:
        with ProcessPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = [pool.submit(convert_one, task) for task in tasks]
            for idx, future in enumerate(as_completed(futures), 1):
                result = future.result()
                if result.get("ok"):
                    summary["ok"] = int(summary["ok"]) + 1
                else:
                    summary["failed"] = int(summary["failed"]) + 1
                    reason = str(result.get("reason", "unknown"))
                    reasons = summary["reasons"]
                    assert isinstance(reasons, dict)
                    reasons[reason] = int(reasons.get(reason, 0)) + 1
                    failures.write(json.dumps(result, ensure_ascii=False) + "\n")
                if idx % 1000 == 0:
                    print(f"processed {idx}/{len(tasks)} ok={summary['ok']} failed={summary['failed']}", flush=True)

    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
