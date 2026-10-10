"""Symbol rows -> MusicXML with whichever HOMR source is on the Python path (the OTS fork or upstream).

Input JSON: [{"id": ..., "rows": [[rhythm, pitch, lift, articulation, slur, position], ...]}]; writes <out>/<id>.musicxml.
This is the provider's own `regenerate` step (homr_engine.py) without the worker, so it needs no model.
"""

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from homr.music_xml_generator import XmlGeneratorArguments, generate_xml
from homr.transformer.vocabulary import EncodedSymbol, remove_duplicated_symbols

items = json.loads(Path(sys.argv[1]).read_text())
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
failed = []
for item in items:
    try:
        staff = remove_duplicated_symbols([EncodedSymbol(rhythm=r[0], pitch=r[1], lift=r[2], articulation=r[3], slur=r[4], position=r[5]) for r in item["rows"]])
        xml = generate_xml(XmlGeneratorArguments(), [staff], "")
        (out / f"{item['id']}.musicxml").write_bytes(ET.tostring(xml, encoding="utf-8", xml_declaration=True))
    except Exception as error:  # noqa: BLE001 - one bad staff must not stop the batch
        failed.append((item["id"], type(error).__name__))
print(json.dumps({"written": len(items) - len(failed), "failed": failed}))
