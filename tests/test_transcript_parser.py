"""Tests for scripts/transcript_parser.py."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import transcript_parser as tp  # noqa: E402

from tests.helpers import make_synthetic_transcript


def test_parse_transcript_missing_file_returns_empty():
    assert tp.parse_transcript("/no/such/path.jsonl") == {}


def test_parse_transcript_well_formed(tmp_path):
    path = str(tmp_path / "t.jsonl")
    make_synthetic_transcript(path, session_id="sid", num_turns=3)
    result = tp.parse_transcript(path)
    assert result != {}
    assert len(result["messages"]) == 6  # 3 user + 3 assistant
    assert len(result["usage_per_message"]) == 3  # only assistant has usage
    assert result["model"] == "claude-opus-4-7"


def test_parse_transcript_skips_malformed_lines(tmp_path):
    path = str(tmp_path / "t.jsonl")
    with open(path, "w") as f:
        f.write('{"type": "user", "sessionId": "s", "message": {}}\n')
        f.write('not-json\n')  # should be skipped
        f.write('{"type": "assistant", "sessionId": "s", "message": {"usage": {"input_tokens": 100, "output_tokens": 50}}}\n')
    result = tp.parse_transcript(path)
    assert len(result["messages"]) == 2
    assert len(result["usage_per_message"]) == 1


def test_find_transcript_path_returns_none_for_unknown(tmp_path):
    assert tp.find_transcript_path("nonexistent-session", cwd=str(tmp_path)) is None


def test_compute_usage_totals_basic(tmp_path):
    path = str(tmp_path / "t.jsonl")
    make_synthetic_transcript(
        path, session_id="s", num_turns=3,
        input_tokens_per_turn=1000, output_tokens_per_turn=500,
        cache_read_tokens=200, cache_creation_tokens=100,
    )
    t = tp.parse_transcript(path)
    totals = tp.compute_usage_totals(t)
    assert totals["input"] == 3000
    assert totals["output"] == 1500
    assert totals["cache_read"] == 600
    assert totals["cache_creation"] == 300
    assert totals["total"] == 3000 + 1500 + 600 + 300
    # cache_hit_rate = cache_read / (cache_read + input (uncached))
    # With input_tokens already excluding cached, cache_hit_rate = 600 / (600 + 3000) = 16.67%
    assert 10.0 < totals["cache_hit_rate"] < 20.0


def test_compute_usage_totals_empty():
    totals = tp.compute_usage_totals({})
    assert totals == {
        "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0,
        "total": 0, "cache_hit_rate": 0.0,
    }
