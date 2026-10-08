import copy

import numpy as np
from scipy import sparse
from semantic_text_pilot import CONFIG, fit, objective, predict_rows


def test_logistic_gradient_matches_finite_differences():
    x = sparse.csr_matrix([[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]])
    labels = np.array([0.0, 1.0, 1.0])
    weights = np.array([0.5, 0.25, 0.25])
    theta = np.array([0.2, -0.3, 0.4])
    _, gradient = objective(theta, x, labels, weights)
    numerical = []
    for index in range(len(theta)):
        delta = np.zeros_like(theta)
        delta[index] = 1e-6
        numerical.append(
            (
                objective(theta + delta, x, labels, weights)[0]
                - objective(theta - delta, x, labels, weights)[0]
            )
            / 2e-6
        )
    assert np.allclose(gradient, numerical, atol=1e-8)


def test_empty_abstains_and_reference_metadata_cannot_change_prediction():
    model = {
        "config": CONFIG,
        "vocabulary": ["ab"],
        "idf": [1.0],
        "weights": [10.0],
        "intercept": 0.0,
    }
    inputs = [{"id": "a", "text": "ab"}, {"id": "b", "text": " "}]
    predictions = predict_rows(model, inputs)
    assert predictions[0]["prediction"] == "Lyrics"
    assert predictions[1]["prediction"] == "Unknown"
    assert predictions[1]["lyric_probability"] is None
    changed = copy.deepcopy(inputs)
    for row in changed:
        row.update(
            score="secret score",
            ground_truth_role="DirectionText",
            annotation_text="secret transcription",
            confidence=0.0,
        )
    assert predict_rows(model, changed) == predictions


def test_training_features_use_only_training_text_and_fit_is_deterministic():
    texts = ["allegro tempo", "allegro tempo", "words are sung", "words are sung"]
    labels = [0, 0, 1, 1]
    first = fit(texts, labels)
    second = fit(texts, labels)
    assert first == second
    assert "zz" not in first["vocabulary"]
    before = copy.deepcopy(first)
    predict_rows(first, [{"id": "external", "text": "zzzz never seen"}])
    assert first == before
    assert first["config"]["threshold"] == 0.95
