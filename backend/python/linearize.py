import sys
import zipfile
import re
import xml.etree.ElementTree as ET

from lmx.linearization.Linearizer import Linearizer
from lmx.symbolic.MxlFile import MxlFile


def load_tree_from_mxl(path: str) -> ET.ElementTree:
    with zipfile.ZipFile(path, "r") as archive:
        # Prefer META-INF/container.xml if present
        try:
            container_xml = archive.read("META-INF/container.xml").decode("utf-8", "replace")
            m = re.search(r"full-path\s*=\s*\"([^\"]+)\"", container_xml, re.IGNORECASE)
            if m:
                inner = m.group(1)
                data = archive.read(inner)
                return ET.ElementTree(ET.fromstring(data))
        except KeyError:
            pass

        # Fallback: choose largest non-META-INF *.musicxml or *.xml file
        candidates = [
            info for info in archive.infolist()
            if not info.filename.lower().startswith("meta-inf/")
            and (info.filename.lower().endswith(".musicxml") or info.filename.lower().endswith(".xml"))
        ]
        if not candidates:
            raise RuntimeError("No XML document found inside MXL archive")

        candidates.sort(key=lambda i: i.file_size, reverse=True)
        data = archive.read(candidates[0].filename)
        return ET.ElementTree(ET.fromstring(data))


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: linearize.py <input.mxl|input.xml>", file=sys.stderr)
        return 2

    path = sys.argv[1]
    try:
        if path.lower().endswith(".mxl"):
            tree = load_tree_from_mxl(path)
        else:
            with open(path, "rb") as f:
                data = f.read()
            tree = ET.ElementTree(ET.fromstring(data))

        mxl = MxlFile(tree)
        try:
            part = mxl.get_piano_part()
        except Exception:
            part = mxl.tree.find("part")

        if part is None or part.tag != "part":
            print("No <part> element found.", file=sys.stderr)
            return 1

        linearizer = Linearizer(errout=sys.stderr)
        linearizer.process_part(part)
        output_lmx = " ".join(linearizer.output_tokens)
        sys.stdout.write(output_lmx)
        return 0
    except Exception as e:
        print(f"linearize.py failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

