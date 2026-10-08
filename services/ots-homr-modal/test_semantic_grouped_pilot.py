from semantic_grouped_pilot import select_policy


def test_selection_rejects_false_directions_even_when_lyric_recall_is_higher():
    unsafe = {
        "lambda": 0.0001,
        "threshold": 0.6,
        "selected_lyrics": 100,
        "false_direction_lyrics": 1,
    }
    safe = {
        "lambda": 0.01,
        "threshold": 0.8,
        "selected_lyrics": 20,
        "false_direction_lyrics": 0,
    }
    assert select_policy([unsafe, safe]) == safe
    assert select_policy([unsafe]) is None


def test_abstaining_candidate_does_not_displace_useful_safe_candidate():
    abstain = {
        "lambda": 0.1,
        "threshold": 0.99,
        "selected_lyrics": 0,
        "false_direction_lyrics": 0,
    }
    useful = {
        "lambda": 0.01,
        "threshold": 0.8,
        "selected_lyrics": 20,
        "false_direction_lyrics": 0,
    }
    assert select_policy([abstain, useful]) == useful
    assert select_policy([abstain]) is None


def test_retention_policy_keeps_ocr_failures_visible_without_confusing_denominators():
    below = {
        "lambda": 0.001,
        "threshold": 0.7,
        "selected_lyrics": 94,
        "false_direction_lyrics": 0,
        "metrics": {"Lyrics": {"support": 120, "empty_text": 20}},
    }
    meets = {**below, "selected_lyrics": 95, "false_direction_lyrics": 2}
    assert select_policy([below, meets], "retain95-proxy") == meets
    assert select_policy([below], "retain95-proxy") is None
    fewer_errors = {**meets, "selected_lyrics": 96, "false_direction_lyrics": 1}
    assert select_policy([meets, fewer_errors], "retain95-proxy") == fewer_errors
    all_empty = {**meets, "metrics": {"Lyrics": {"support": 20, "empty_text": 20}}}
    assert select_policy([all_empty], "retain95-proxy") is None
