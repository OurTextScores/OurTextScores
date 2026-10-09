import unittest

from lyric_line_context_diagnostic import lyric_line_context


class Gate:
    def __init__(self, prediction="Lyrics"):
        self.prediction = prediction

    def classify(self, text):
        return {"prediction": self.prediction, "score": 0.8}


def row(id, box, semantic="Lyrics", staff=0):
    return {
        "id": id,
        "box": box,
        "text": id,
        "semantic": semantic,
        "proposedLyric": semantic == "Lyrics",
        "anchor": {"staffIndex": staff} if semantic == "Lyrics" else None,
    }


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.candidate = row("an", [100, 100, 120, 120], "DirectionText")
        self.peers = [row("a", [60, 100, 80, 120]), row("b", [140, 100, 160, 120])]

    def test_two_aligned_anchored_peers_and_phrase_verdict(self):
        result = lyric_line_context(self.candidate, self.peers, Gate())
        self.assertEqual(result["combinedText"], "a an b")
        self.assertIsNone(
            lyric_line_context(self.candidate, self.peers, Gate("DirectionText"))
        )

    def test_single_peer_or_other_line_is_insufficient(self):
        self.assertIsNone(lyric_line_context(self.candidate, self.peers[:1], Gate()))
        self.peers[1]["box"] = [140, 160, 160, 180]
        self.assertIsNone(lyric_line_context(self.candidate, self.peers, Gate()))

    def test_single_peer_variant_is_explicit_and_still_requires_anchor(self):
        self.assertIsNotNone(
            lyric_line_context(self.candidate, self.peers[:1], Gate(), 1)
        )
        self.peers[0]["anchor"] = None
        self.assertIsNone(lyric_line_context(self.candidate, self.peers[:1], Gate(), 1))

    def test_different_staff_peers_do_not_combine(self):
        self.peers[1]["anchor"]["staffIndex"] = 1
        self.assertIsNone(lyric_line_context(self.candidate, self.peers, Gate()))

    def test_does_not_reclassify_original_lyrics(self):
        self.assertIsNone(lyric_line_context(self.peers[0], self.peers, Gate()))


if __name__ == "__main__":
    unittest.main()
