import base64
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from homr_engine import CODE_NOT_READY, InferenceError, xml_generator_arguments
from homr.music_xml_generator import XmlGeneratorArguments, generate_xml
from homr.transformer.vocabulary import EncodedSymbol
from ots_homr_provider import create_provider_app


class LocalRegenerationEngine:
    """Real runtime regeneration behind the existing HTTP contract; no inference stub claims."""

    def __init__(self, enabled):
        self.enabled = enabled

    def is_ready(self):
        return True

    def warm_up(self):
        pass

    def shutdown(self):
        pass

    def identity(self, detector):
        return (
            {"notationPolicies": {"pairedTremoloTiming": "peer-span-v1"}}
            if self.enabled
            else {}
        )

    def regenerate(self, staffs, title=""):
        import xml.etree.ElementTree as ET

        voices = [[EncodedSymbol(*token) for token in staff] for staff in staffs]
        args = xml_generator_arguments(XmlGeneratorArguments, self.enabled)
        return ET.tostring(
            generate_xml(args, voices, title), encoding="utf-8", xml_declaration=True
        )


class TremoloServicePolicyTest(unittest.TestCase):
    def test_legacy_runtime_off_is_compatible_but_on_fails_closed(self):
        class Legacy:
            pass

        self.assertIsInstance(xml_generator_arguments(Legacy, False), Legacy)
        with self.assertRaises(InferenceError) as error:
            xml_generator_arguments(Legacy, True)
        self.assertEqual(error.exception.code, CODE_NOT_READY)

    def test_explicit_service_off_overrides_ambient_runtime_flag(self):
        with patch.dict("os.environ", {"HOMR_PAIRED_TREMOLO_TIMING": "1"}):
            self.assertFalse(
                xml_generator_arguments(
                    XmlGeneratorArguments, False
                ).paired_tremolo_timing
            )
            self.assertTrue(
                xml_generator_arguments(
                    XmlGeneratorArguments, True
                ).paired_tremolo_timing
            )

    def test_http_regeneration_retains_runtime_on_off_policy(self):
        import xml.etree.ElementTree as ET

        target, peer = [], []
        for bar in range(4):
            for pitch in ["C4", "E4", "D4", "F4"]:
                target.append(
                    [
                        "note_2" if bar == 0 else "note_4",
                        pitch,
                        "_",
                        "tremolo" if bar == 0 else "_",
                        "_",
                        "upper",
                    ]
                )
                peer.append(["note_4", "G4", "_", "_", "_", "upper"])
            target.append(["barline", ".", ".", ".", ".", "."])
            peer.append(["barline", ".", ".", ".", ".", "."])
        outputs = []
        for enabled in (False, True):
            app = create_provider_app(
                engine=LocalRegenerationEngine(enabled),
                service_revision="local-tremolo-contract-smoke",
                provider_token="local-test",
            )
            with TestClient(app) as client:
                response = client.post(
                    "/v1/regenerate",
                    json={"staffs": [target, peer]},
                    headers={"Authorization": "Bearer local-test"},
                )
                self.assertEqual(response.status_code, 200, response.text)
                outputs.append(
                    ET.fromstring(
                        base64.b64decode(response.json()["result"]["musicXmlBase64"])
                    )
                )
                capabilities = client.get("/v1/capabilities").json()
                if enabled:
                    self.assertIn("notationPolicies", capabilities)
                else:
                    self.assertNotIn("notationPolicies", capabilities)
        self.assertEqual(outputs[0].findtext("part/measure/note/type"), "half")
        self.assertEqual(outputs[1].findtext("part/measure/note/type"), "half")
        self.assertIsNone(outputs[0].find("part/measure/note/time-modification"))
        self.assertEqual(
            outputs[1].findtext("part/measure/note/time-modification/actual-notes"), "2"
        )
