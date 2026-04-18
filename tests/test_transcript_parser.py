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
