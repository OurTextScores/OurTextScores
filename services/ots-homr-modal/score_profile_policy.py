"""Structural policy for a caller-supplied score profile.

Deliberately free of the web stack and of homr itself, so the rules can be tested
on their own. What the parts *mean* is homr's business and
`ScoreProfile.from_dict` is the authority on it; this exists so a caller gets a 4xx
naming the problem instead of an inference failure much later, and so a schema bump
is a refusal rather than a silent misread.
"""

from __future__ import annotations

#: A profile describes one score's parts, not a catalogue. Bounds the request before
#: it is parsed at all.
MAX_SCORE_PROFILE_BYTES = 64 * 1024
SCORE_PROFILE_SCHEMA_VERSION = "homr.score-profile.v1"


def validate_score_profile(data: object) -> None:
    """Reject a profile this build cannot read, rather than guess at its shape.

    Deliberately structural only. What the parts *mean* is homr's business, and
    `ScoreProfile.from_dict` in the child raises on anything this misses - this exists
    so a caller gets a 4xx naming the problem instead of an inference failure much
    later, and so a schema bump is a refusal rather than a silent misread.
    """
    if not isinstance(data, dict):
        raise ValueError("profile must be an object")
    if data.get("schemaVersion") != SCORE_PROFILE_SCHEMA_VERSION:
        raise ValueError(f"unsupported schema {data.get('schemaVersion')!r}")
    parts = data.get("parts")
    if not isinstance(parts, list) or not parts:
        raise ValueError("profile must declare at least one part")
    seen = set()
    for part in parts:
        if not isinstance(part, dict):
            raise ValueError("each part must be an object")
        stable_id = part.get("stableId")
        if not isinstance(stable_id, str) or not stable_id.strip():
            raise ValueError("each part needs a stableId")
        if stable_id in seen:
            raise ValueError(f"duplicate stableId {stable_id!r}")
        seen.add(stable_id)
