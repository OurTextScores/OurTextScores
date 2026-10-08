import copy

import pytest
import tremolo_provider_candidate_spec as candidate


def minimal_manifest():
    return {
        "archiveSha256": candidate.SOURCE_INPUTS["source/homr-b6eca7-source.tar.gz"],
        "patches": {
            name.split("/")[-1]: digest
            for name, digest in candidate.SOURCE_INPUTS.items()
            if name.startswith("patches/")
        },
        "structuredExportFamilies": copy.deepcopy(candidate.FAMILIES),
    }


def test_source_tampering_rejected(monkeypatch):
    monkeypatch.setattr(candidate, "sha", lambda path: "0" * 64)
    with pytest.raises(ValueError, match="Source input hash mismatch"):
        candidate.specification(minimal_manifest())


@pytest.mark.parametrize(
    "families",
    [
        {"core": "none", "additional-heads": "beam,stem,tie,slur,advance"},
        {"core": "beam", "additional-heads": "beam,stem,tie,slur"},
    ],
)
def test_unqualified_worker_policy_rejected(monkeypatch, families):
    monkeypatch.setattr(
        candidate,
        "sha",
        lambda path: candidate.SOURCE_INPUTS[
            next(name for name in candidate.SOURCE_INPUTS if str(path).endswith(name))
        ],
    )
    manifest = minimal_manifest()
    manifest["structuredExportFamilies"] = families
    with pytest.raises(ValueError, match="exclude rhythmic advance"):
        candidate.specification(manifest)


def test_shipping_graph_cannot_inherit_experimental_qualification(monkeypatch):
    monkeypatch.setattr(
        candidate,
        "sha",
        lambda path: candidate.SOURCE_INPUTS[
            next(name for name in candidate.SOURCE_INPUTS if str(path).endswith(name))
        ],
    )
    manifest = minimal_manifest()
    manifest["graphs"] = {
        "encoder": {
            "sha256": "f5b429929b17c375f2940739d00e04c62592f75afe4aeba6112859a6eb427aa1"
        }
    }
    with pytest.raises(ValueError, match="Experimental graph identity mismatch"):
        candidate.specification(manifest)
