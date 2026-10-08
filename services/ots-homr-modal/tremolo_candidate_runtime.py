"""Offline-testable worker policy and provenance for the private fp16 candidate."""

import json
import os

from tremolo_provider_candidate_spec import FAMILIES, SOURCE_INPUTS


def candidate_worker_factory(engine_factory):
    def create(**options):
        options["structured_export_families"] = (
            FAMILIES["additional-heads"]
            if options["structured_heads_path"]
            else FAMILIES["core"]
        )
        return engine_factory(**options)

    return create


def candidate_engine_class(base):
    class CandidateEngine(base):
        def identity(self, text_detector):
            result = super().identity(text_detector)
            result["providerCandidate"] = {
                "qualification": "unqualified-private-fp16-stack",
                "pairedTremoloTiming": os.environ.get("OTS_HOMR_PAIRED_TREMOLO_TIMING")
                == "1",
                "graphFamily": "shipping-private-fp16-not-experimental-fp32",
                "serviceSourceSha256": json.loads(
                    os.environ.get("OTS_CANDIDATE_SERVICE_SOURCE_SHA256", "{}")
                ),
                "experimentalFp32EvidenceTransfers": False,
                "sourceInputs": dict(SOURCE_INPUTS),
                "structuredExportFamilies": dict(FAMILIES),
            }
            return result

    return CandidateEngine
