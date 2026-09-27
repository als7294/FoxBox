import json

import pytest

from fvwks_contracts.models import DEFAULT_LEXICON
from fvwks_voice.errors import VoiceError
from fvwks_voice.lexicon import Lexicon
from fvwks_voice.markup import MAX_SCRIPT_CHARS, Piece, parse, speak_chunk
from fvwks_voice.api import preview_script


def _cases(fixtures_dir):
    return json.loads((fixtures_dir / "markup_cases.json").read_text())["cases"]


def test_shared_markup_cases(fixtures_dir):
    """fixtures/markup_cases.json is the reference shared with S4's ScriptEditor."""
    for case in _cases(fixtures_dir):
        got = preview_script(case["script"], DEFAULT_LEXICON, bpm=140).model_dump()
        assert got["segments"] == case["segments"], case["script"]
        assert got["warnings"] == []


def test_preview_reports_warnings():
    assert preview_script("EXPECT *US").warnings == ["Ignored an unmatched '*'."]


def test_beat_break_flags_the_chunk_before_the_bar():
    s = parse("WE ARE GUY FVWKS | EXPECT *US*")
    assert [c.text for c in s.chunks] == ["WE ARE GUY FVWKS", "EXPECT *US*"]
    assert [c.beat_break for c in s.chunks] == [True, False]
    assert [c.throw for c in s.chunks] == [False, True]
    assert s.chunks[1].pieces == (Piece("EXPECT ", False), Piece("US", True))


@pytest.mark.parametrize("tag, secs, beats", [
    ("[0.5]", 0.5, 0), ("[0.5s]", 0.5, 0), ("[.25]", 0.25, 0), ("[500ms]", 0.5, 0), ("[ 1.5 sec ]", 1.5, 0),
    ("[2b]", 0, 2), ("[2 beats]", 0, 2), ("[1/2b]", 0, 0.5), ("[3/4 b]", 0, 0.75), ("[1B]", 0, 1),
])
def test_pause_units(tag, secs, beats):
    s = parse(f"ONE {tag} TWO")
    assert len(s.chunks) == 2
    assert s.chunks[0].pause_after_s == pytest.approx(secs)
    assert s.chunks[0].pause_after_beats == pytest.approx(beats)
    assert not s.chunks[0].beat_break


def test_pause_seconds_use_bpm():
    c = parse("ONE [2b] [0.25] TWO").chunks[0]
    assert c.pause_seconds(120) == pytest.approx(1.25)
    assert c.pause_seconds(140) == pytest.approx(0.25 + 2 * 60 / 140)


def test_consecutive_breaks_merge_and_empty_chunks_vanish():
    s = parse("ONE | [1b] | ... | TWO |")
    assert [c.text for c in s.chunks] == ["ONE", "TWO"]
    assert s.chunks[0].beat_break and s.chunks[0].pause_after_beats == 1
    assert s.chunks[1].beat_break  # a trailing bar is kept as written


def test_trailing_pause_belongs_to_last_chunk():
    s = parse("EXPECT US [2b]")
    assert len(s.chunks) == 1 and s.chunks[0].pause_after_beats == 2


def test_leading_pause_is_ignored_with_warning():
    s = parse("[1b] WE ARE")
    assert [c.text for c in s.chunks] == ["WE ARE"]
    assert any("pre-roll" in w for w in s.warnings)


def test_newline_splits_without_contract_flags():
    s = parse("WE ARE LEGION\r\nEXPECT US")
    assert [c.text for c in s.chunks] == ["WE ARE LEGION", "EXPECT US"]
    first = s.chunks[0]
    assert first.line_break and not first.beat_break and first.pause_after_s == 0


def test_throw_spanning_a_break_flags_both_chunks():
    s = parse("*EXPECT | US*")
    assert [c.throw for c in s.chunks] == [True, True]
    assert [c.text for c in s.chunks] == ["*EXPECT", "US*"]


def test_multi_word_throw_and_punctuation():
    c = parse("*WE ARE*, GUY FVWKS!").chunks[0]
    assert c.pieces == (Piece("WE ARE", True), Piece(", GUY FVWKS!", False))
    assert c.clean_text == "WE ARE, GUY FVWKS!"
    # punctuation-only runs never start a piece of their own
    assert parse("EXPECT *US*!").chunks[0].pieces == (Piece("EXPECT ", False), Piece("US!", True))


def test_unmatched_star_is_dropped():
    s = parse("EXPECT *US")
    assert s.chunks[0].pieces == (Piece("EXPECT US", False),)
    assert not s.chunks[0].throw
    assert any("unmatched" in w for w in s.warnings)


def test_unknown_tag_is_dropped():
    s = parse("Hi [laughs] there")
    assert s.chunks[0].clean_text == "Hi there"
    assert s.chunks[0].text == "Hi [laughs] there"
    assert any("[laughs]" in w for w in s.warnings)


def test_escapes_are_literal():
    s = parse(r"A \| B \*C\* \[0.5]")
    assert len(s.chunks) == 1
    assert s.chunks[0].clean_text == "A | B *C* [0.5]"
    assert not s.chunks[0].throw


def test_whitespace_is_collapsed():
    c = parse("  WE   ARE\t\tLEGION  ").chunks[0]
    assert c.clean_text == "WE ARE LEGION" and c.text == "WE   ARE\t\tLEGION"


def test_empty_and_markup_only_scripts_have_no_chunks():
    assert parse("").chunks == ()
    assert parse(" | [1b] *...* ").chunks == ()


def test_limits():
    with pytest.raises(VoiceError) as e:
        parse("A" * (MAX_SCRIPT_CHARS + 1))
    assert e.value.code == "script_too_long"
    with pytest.raises(VoiceError) as e:
        parse("A [31] B")
    assert e.value.code == "pause_too_long"
    with pytest.raises(VoiceError):
        parse("A [65b] B")


def test_segment_structure_is_voice_independent():
    """STACK relies on this: chunks come from the script alone."""
    script = "REMEMBER, REMEMBER [0.5] THE SIGNAL NEVER DIES | WE DO NOT FORGIVE | *EXPECT US*"
    assert parse(script) == parse(script)
    assert parse(script).segment_count == 4


def test_speak_chunk_sentence_mode():
    lex = Lexicon.from_contract(DEFAULT_LEXICON)
    c = parse("WE ARE GUY FVWKS").chunks[0]
    sp = speak_chunk(c, lex)
    assert sp.say == "we are guy Fawkes"
    assert sp.plain == sp.g2p == "We are guy Fawkes."
    assert speak_chunk(parse("remember, remember,").chunks[0], lex).plain == "Remember, remember,"
    assert speak_chunk(parse("WHO ARE WE?").chunks[0], lex).plain == "Who are we?"
    assert speak_chunk(parse("2 FAST").chunks[0], lex).plain == "2 fast."


def test_speak_chunk_spans_cover_pieces():
    lex = Lexicon.from_contract(DEFAULT_LEXICON)
    c = parse("EXPECT *FVWKS* NOW").chunks[0]
    sp = speak_chunk(c, lex)
    assert [sp.plain[a:b] for a, b in sp.spans] == ["Expect ", "Fawkes", " now"]


@pytest.mark.parametrize("script, throw_word", [
    ("*FV*WKS IS HERE", "FVWKS"), ("FV*WKS* IS HERE", "FVWKS"), ("SIG*NAL* IS COMING", "SIGNAL"),
    ("*DON'*T GO", "DON'T"), ("*DON*'T GO", "DON'T"),
])
def test_throw_marks_inside_a_word_throw_the_whole_word(script, throw_word):
    """Found in the app review: '*FV*WKS' split the word, so the lexicon missed FVWKS and TTS read 'fvwks'."""
    pieces = parse(script).chunks[0].pieces
    assert [p.text for p in pieces if p.throw] == [throw_word]
    lex = Lexicon.from_contract(DEFAULT_LEXICON)
    say = speak_chunk(parse(script).chunks[0], lex, sentence=False).say
    assert lex.speak(throw_word).plain.lower() in say.lower() and "fvwks" not in say.lower()
