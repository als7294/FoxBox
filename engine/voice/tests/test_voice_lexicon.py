import json

import pytest

from fvwks_contracts.models import DEFAULT_LEXICON, Lexicon as ContractLexicon, LexiconEntry
from fvwks_voice.errors import VoiceError
from fvwks_voice.lexicon import Lexicon, apply_caps_rule, load_user_lexicon, save_user_lexicon


@pytest.mark.parametrize("text, expected", [
    ("EXPECT US", "expect us"),
    ("WE DO NOT FORGIVE", "we do not forgive"),
    ("DON'T STOP", "don't stop"),
    ("I AM LEGION", "I am legion"),  # single letters stay
    ("A MESSAGE", "A message"),
    ("MP3 FILES", "MP3 files"),  # words with digits stay
    ("McDONALD", "McDONALD"),  # mixed case isn't ALL-CAPS
    ("Expect us", "Expect us"),
    ("ÉCOUTE", "écoute"),
])
def test_caps_rule(text, expected):
    assert apply_caps_rule(text) == expected


def test_defaults_are_the_contract_default_lexicon():
    lex = Lexicon()
    assert lex.speak("WE ARE GUY FVWKS").plain == "we are guy Fawkes"
    assert lex.to_contract_rows() == [e.model_dump() for e in DEFAULT_LEXICON.entries]


def test_matching_is_whole_word_and_case_insensitive():
    lex = Lexicon()
    assert lex.speak("fvwks Fvwks FVWKS").plain == "Fawkes Fawkes Fawkes"
    assert lex.speak("FVWKSX XFVWKS").plain == "fvwksx xfvwks"  # not whole words -> caps rule only
    assert lex.speak("FVWKS's mask").plain == "Fawkes's mask"
    assert lex.speak("FVWKS'S MASK").plain == "Fawkes's mask"


def test_default_acronyms_stay_spelled():
    lex = Lexicon()
    assert lex.speak("THE DJ AND THE MC").plain == "the DJ and the MC"
    assert lex.speak("the dj").plain == "the DJ"


def test_user_entries_override_and_remove():
    lex = Lexicon({"DJ": {"say": "deejay"}, "NSA": None, "FVWKS": "Fox"})
    assert lex.speak("DJ NSA FVWKS").plain == "deejay nsa Fox"


def test_multi_word_keys_win_over_single_words():
    lex = Lexicon({"GUY FVWKS": "Guy Fawkes the Third"})
    assert lex.speak("WE ARE GUY   FVWKS").plain == "we are Guy Fawkes the Third"
    assert lex.speak("FVWKS").plain == "Fawkes"


def test_phoneme_entries_become_misaki_links():
    lex = Lexicon({"GIF": {"phonemes": "/ʤˈɪf/"}})
    sp = lex.speak("SEND A GIF")
    assert sp.plain == "send A gif"
    assert sp.g2p == "send A [gif](/ʤˈɪf/)"


def test_say_respelling_gets_the_caps_rule_unless_acronym():
    lex = Lexicon({"GFX": {"say": "GRAPHICS"}, "CDJS": {"say": "CDJs", "acronym": True}})
    assert lex.speak("GFX ON CDJS").plain == "graphics on CDJs"


def test_from_contract():
    user = ContractLexicon(entries=[
        LexiconEntry(word="BRB", say="be right back"),
        LexiconEntry(word="FVWKS", say="/fˈɔks/"),
        LexiconEntry(word="VIP", say="VIP", acronym=False),
        LexiconEntry(word="GUY", say="GUY", acronym=True),
    ])
    lex = Lexicon.from_contract(user)
    sp = lex.speak("FVWKS VIP GUY BRB")
    assert sp.g2p == "[fvwks](/fˈɔks/) vip GUY be right back"
    assert sp.plain == "fvwks vip GUY be right back"
    rows = lex.to_contract_rows()
    assert {"word": "FVWKS", "say": "/fˈɔks/", "acronym": False} in rows
    assert ContractLexicon(entries=[LexiconEntry(**r) for r in rows])  # rows validate against the contract


def test_contract_lexicon_is_the_complete_user_list():
    """v0.1 ruling: deleting FVWKS (or DJ) in the UI really deletes it; nothing hidden stays underneath."""
    lex = Lexicon.from_contract(ContractLexicon(entries=[LexiconEntry(word="BRB", say="be right back")]))
    assert lex.speak("FVWKS DJ BRB").plain == "fvwks dj be right back"
    assert Lexicon.from_contract(None).speak("FVWKS DJ").plain == "Fawkes DJ"


@pytest.mark.parametrize("bad", [
    {"X": ""}, {"X": 3}, {"X": {}}, {"X": {"say": 1}}, {"X": {"acronym": "yes"}},
    {"X": {"phonemes": "[a](b)"}}, {"...": "dots"}, [{"say": "no word"}], "not a mapping",
])
def test_invalid_entries_raise(bad):
    with pytest.raises(VoiceError) as e:
        Lexicon(bad)
    assert e.value.code == "lexicon_invalid"


def test_json_formats(tmp_path):
    bare = tmp_path / "bare.json"
    bare.write_text(json.dumps({"FVWKS": "Fox"}))
    wrapped = tmp_path / "wrapped.json"
    wrapped.write_text(json.dumps({"entries": {"FVWKS": {"say": "Fox"}}}))
    rows = tmp_path / "rows.json"
    rows.write_text(json.dumps({"entries": [{"word": "FVWKS", "say": "Fox"}]}))
    for p in (bare, wrapped, rows):
        assert Lexicon.from_json(p).speak("FVWKS").plain == "Fox"
    assert Lexicon.from_json(tmp_path / "missing.json").speak("FVWKS").plain == "Fawkes"
    broken = tmp_path / "broken.json"
    broken.write_text("{nope")
    with pytest.raises(VoiceError):
        Lexicon.from_json(broken)


def test_save_and_reload_keeps_removals(tmp_path, monkeypatch):
    path = tmp_path / "lexicon.json"
    monkeypatch.setenv("FVWKS_LEXICON", str(path))
    merged = save_user_lexicon({"FVWKS": None, "BRB": {"say": "be right back"}})
    assert merged.speak("FVWKS BRB DJ").plain == "fvwks be right back DJ"
    saved = json.loads(path.read_text())
    assert saved["entries"]["FVWKS"] is None
    assert load_user_lexicon().speak("FVWKS").plain == "fvwks"
