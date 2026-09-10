"""Every global name these modules use is actually defined or imported.

`ots_homr_provider` cannot be imported in this environment - it pulls in fastapi, which
is only present in the built image - so nothing here ever executed its module body, and
a missing import survived every local test to fail in production with
`NameError: name 'MAX_SCORE_PROFILE_BYTES' is not defined` on the first request that
used it.

This is a static stand-in for the import that cannot happen: walk the AST, collect what
each module defines or imports, and check nothing it reads is absent. Cheap, and it
catches the one failure mode local testing structurally cannot.
"""

import ast
import builtins
import pathlib
import unittest

MODULES = [
    "ots_homr_provider.py",
    "score_profile_policy.py",
    "ots_engine.py",
    "homr_core.py",
    "homr_engine.py",
    "runtime_identity.py",
    "onnx_core.py",
    "bootstrap.py",
    "pins.py",
]


def undefined_names(source: str) -> list[str]:
    tree = ast.parse(source)
    # Module dunders exist at runtime without ever being assigned.
    defined: set[str] = set(dir(builtins)) | {
        "__file__",
        "__name__",
        "__doc__",
        "__package__",
        "__spec__",
        "__loader__",
    }
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                defined.add((alias.asname or alias.name).split(".")[0])
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined.add(node.name)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            defined.add(node.id)
        elif isinstance(node, ast.arg):
            defined.add(node.arg)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            defined.update(node.names)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            defined.add(node.name)
        elif isinstance(node, ast.alias) and node.asname:
            defined.add(node.asname)
    used = {
        node.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
    }
    return sorted(used - defined)


class TestModuleNamesResolve(unittest.TestCase):
    def test_every_module_defines_what_it_reads(self) -> None:
        here = pathlib.Path(__file__).parent
        for name in MODULES:
            path = here / name
            if not path.is_file():
                continue
            with self.subTest(module=name):
                self.assertEqual(undefined_names(path.read_text()), [])

    def test_the_check_would_have_caught_the_real_bug(self) -> None:
        # Not a hypothetical: this is the shape that reached production.
        self.assertEqual(
            undefined_names("def f(x):\n    if x > MAX_SCORE_PROFILE_BYTES:\n        pass\n"),
            ["MAX_SCORE_PROFILE_BYTES"],
        )

    def test_ordinary_bindings_are_not_reported(self) -> None:
        source = (
            "import os\n"
            "from typing import Any\n"
            "CONST = 1\n"
            "def f(a, *, b=2):\n"
            "    try:\n"
            "        return os.path, Any, CONST, a, b\n"
            "    except OSError as error:\n"
            "        return error\n"
        )
        self.assertEqual(undefined_names(source), [])


if __name__ == "__main__":
    unittest.main()
