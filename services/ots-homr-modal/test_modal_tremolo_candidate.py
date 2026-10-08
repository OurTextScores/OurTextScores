"""Offline policy/AST checks: never import the live Modal entrypoint."""

import ast
from pathlib import Path

from tremolo_candidate_runtime import candidate_engine_class, candidate_worker_factory
from tremolo_provider_candidate_spec import SOURCE_INPUTS


def test_worker_roles_disable_advance_and_plain_heads():
    factory = candidate_worker_factory(lambda **options: options)
    assert factory(structured_heads_path="")["structured_export_families"] == "none"
    assert (
        factory(structured_heads_path="/heads.onnx")["structured_export_families"]
        == "beam,stem,tie,slur"
    )


def test_candidate_identity_keeps_real_graph_pins_and_marks_unqualified():
    class Base:
        def identity(self, detector):
            return {"core": "actual-private-pin", "textDetector": detector}

    identity = candidate_engine_class(Base)().identity("none")
    assert identity["core"] == "actual-private-pin"
    assert identity["providerCandidate"]["experimentalFp32EvidenceTransfers"] is False
    assert identity["providerCandidate"]["sourceInputs"] == SOURCE_INPUTS


def test_separate_entrypoint_locks_inputs_without_importing_modal():
    source = Path(__file__).with_name("modal_tremolo_candidate.py").read_text()
    tree = ast.parse(source)
    assert isinstance(tree, ast.Module)
    assert '"ots-homr-tremolo-candidate-models"' in source
    for relative in SOURCE_INPUTS:
        if relative.startswith("patches/"):
            assert relative.split("/")[-1] in source
    assert source.count("sha256sum --check --strict") == 4
    assert source.count("git apply --check") == 3
    assert '"OTS_HOMR_PAIRED_TREMOLO_TIMING": CANDIDATE_TIMING' in source
    assert "candidate_worker_factory(HomrEngine)" in source
    assert 'bootstrap(root=Path("/models/ots-homr"), device="cuda")' in source
    assert "accepted-experimental" not in source


def load_fake_candidate(monkeypatch, arm):
    import importlib.util
    import sys
    import types

    calls = []

    class Image:
        @classmethod
        def from_registry(cls, *args, **kwargs):
            calls.append(("from_registry", args, kwargs))
            return cls()

        def __getattr__(self, name):
            def call(*args, **kwargs):
                calls.append((name, args, kwargs))
                return self

            return call

    class Resource:
        @classmethod
        def from_name(cls, *args, **kwargs):
            calls.append((cls.__name__, args, kwargs))
            return cls()

    class Volume(Resource):
        pass

    class Secret(Resource):
        pass

    def decorator(*args, **kwargs):
        calls.append(("decorator", args, kwargs))
        return lambda function: function

    class App:
        def __init__(self, name):
            calls.append(("app", (name,), {}))

        function = staticmethod(decorator)

    fake = types.SimpleNamespace(
        Image=Image,
        Volume=Volume,
        Secret=Secret,
        App=App,
        concurrent=decorator,
        asgi_app=decorator,
    )
    monkeypatch.setitem(sys.modules, "modal", fake)
    monkeypatch.setenv("OTS_SOURCE_COMMIT", "a" * 40)
    monkeypatch.setenv("OTS_CANDIDATE_PAIRED_TREMOLO_TIMING", arm)
    spec = importlib.util.spec_from_file_location(
        "offline_modal_candidate",
        Path(__file__).with_name("modal_tremolo_candidate.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, calls


def test_offline_image_recipe_copies_and_verifies_every_service_input(monkeypatch):
    import json
    import shlex

    module, calls = load_fake_candidate(monkeypatch, "1")
    env = next(args[0] for name, args, kwargs in calls if name == "env")
    assert env["OTS_HOMR_PAIRED_TREMOLO_TIMING"] == "1"
    assert (
        json.loads(env["OTS_CANDIDATE_SERVICE_SOURCE_SHA256"])
        == module.SERVICE_INPUT_SHA256
    )
    directories = [
        (Path(args[0]), Path(kwargs["remote_path"]))
        for name, args, kwargs in calls
        if name == "add_local_dir"
    ]
    for remote in module.SERVICE_INPUT_SHA256:
        matching = [
            (local, base)
            for local, base in directories
            if Path(remote).is_relative_to(base)
        ]
        assert len(matching) == 1
        local, base = matching[0]
        assert (local / Path(remote).relative_to(base)).is_file()
    assert any(
        module.SERVICE_HASH_CHECK in args
        for name, args, kwargs in calls
        if name == "run_commands"
    )
    # Parse the actual shell-quoted Python probe without executing image commands.
    check_code = shlex.split(module.SERVICE_HASH_CHECK)[2]
    compile(check_code, "source-hash-check", "exec")
    assert any(
        args == ("ots-homr-tremolo-candidate-models",)
        for name, args, kwargs in calls
        if name == "Volume"
    )
    assert any(
        args == ("ourtextscores-ots-homr-tremolo-private-fp16-candidate-on",)
        for name, args, kwargs in calls
        if name == "app"
    )
    commands = [
        command
        for name, args, kwargs in calls
        if name == "run_commands"
        for command in args
    ]
    assert sum("sha256sum --check --strict" in command for command in commands) == 4
    assert sum("git apply --check" in command for command in commands) == 3


def test_disabled_candidate_arm_is_distinct(monkeypatch):
    module, calls = load_fake_candidate(monkeypatch, "0")
    assert module.SERVICE_REVISION.endswith("-off")
    env = next(args[0] for name, args, kwargs in calls if name == "env")
    assert env["OTS_HOMR_PAIRED_TREMOLO_TIMING"] == "0"
    assert any(
        args == ("ourtextscores-ots-homr-tremolo-private-fp16-candidate-off",)
        for name, args, kwargs in calls
        if name == "app"
    )


def test_factory_preserves_timing_for_both_worker_roles():
    factory = candidate_worker_factory(lambda **options: options)
    for enabled in (False, True):
        for path in ("", "/heads.onnx"):
            result = factory(structured_heads_path=path, paired_tremolo_timing=enabled)
            assert result["paired_tremolo_timing"] is enabled


def test_invalid_candidate_arm_rejected_before_resources(monkeypatch):
    import pytest

    with pytest.raises(ValueError, match="must be 0 or 1"):
        load_fake_candidate(monkeypatch, "true")
