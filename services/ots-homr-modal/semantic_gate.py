"""Pure-Python inference for the frozen lyric/direction text classifier (no numpy or sklearn).

The model is the recall-oriented character 2-5gram TF-IDF logistic classifier from the C1 pilot. Its
probability is an UNCALIBRATED score, not a precision. Empty OCR text is always Unknown. At the pinned
threshold 0.5 a non-empty text is `Lyrics` or `DirectionText`; the gate is review-assisting, never an
unattended attachment decision.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from collections import Counter
from pathlib import Path

#: SHA-256 of models/semantic-lyrics-v1.json; load refuses any other file.
MODEL_SHA256 = "82da7a641985d4c2baf75e57efe06dbe9bf57f5a49c9186cfd30f50a8887d5d1"
DEFAULT_MODEL = Path(__file__).resolve().parent / "models" / "semantic-lyrics-v1.json"


def normalized(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).lower()).strip()


class SemanticGate:
    def __init__(self, model: dict) -> None:
        self.threshold = float(model["config"]["threshold"])
        self.ngrams = tuple(model["config"]["ngrams"])
        self.index = {term: i for i, term in enumerate(model["vocabulary"])}
        self.idf = model["idf"]
        self.weights = model["weights"]
        self.intercept = float(model["intercept"])

    @classmethod
    def load(cls, path: Path = DEFAULT_MODEL) -> "SemanticGate":
        data = Path(path).read_bytes()
        if hashlib.sha256(data).hexdigest() != MODEL_SHA256:
            raise ValueError("Semantic model differs from the pinned identity")
        return cls(json.loads(data))

    def score(self, text: str) -> float | None:
        """Probability-like lyric score, or None for empty text."""
        clean = normalized(text)
        if not clean:
            return None
        padded = " " + clean + " "
        counts = Counter(
            padded[i : i + n] for n in self.ngrams for i in range(len(padded) - n + 1)
        )
        values = {}
        for term, count in counts.items():
            column = self.index.get(term)
            if column is not None:
                values[column] = (1 + math.log(count)) * self.idf[column]
        norm = math.sqrt(sum(v * v for v in values.values()))
        logit = self.intercept
        if norm:
            logit += sum(self.weights[c] * v / norm for c, v in values.items())
        if logit >= 0:
            return 1.0 / (1.0 + math.exp(-logit))
        e = math.exp(logit)
        return e / (1.0 + e)

    def classify(self, text: str) -> dict:
        score = self.score(text)
        if score is None:
            return {"prediction": "Unknown", "score": None, "proposedLyric": False}
        lyric = score >= self.threshold
        return {
            "prediction": "Lyrics" if lyric else "DirectionText",
            "score": score,
            "proposedLyric": lyric,
        }
