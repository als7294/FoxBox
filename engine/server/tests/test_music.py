import pytest

from fvwks_server.music import bar_seconds, format_bpm, key_name, parse_key


@pytest.mark.parametrize("text,name,camelot", [
    ("Am", "Am", "8A"), ("A minor", "Am", "8A"), ("a-min", "Am", "8A"), ("8A", "Am", "8A"), ("8a", "Am", "8A"),
    ("C", "C", "8B"), ("C major", "C", "8B"), ("8B", "C", "8B"),
    ("F#m", "F#m", "11A"), ("Gbm", "F#m", "11A"), ("F♯ minor", "F#m", "11A"),
    ("Bbm", "Bbm", "3A"), ("bbm", "Bbm", "3A"), ("A# minor", "Bbm", "3A"),
    ("C#", "Db", "3B"), ("Db major", "Db", "3B"), ("A flat minor", "Abm", "1A"), ("12A", "Dbm", "12A"),
    ("E", "E", "12B"), ("Cb", "B", "1B"), ("AM", "A", "11B"),
])
def test_parse_key(text, name, camelot):
    key = parse_key(text)
    assert key.name == name and key.camelot == camelot


@pytest.mark.parametrize("text", [None, "", "off", "none", "o"])
def test_no_key(text):
    assert parse_key(text) is None and key_name(text) is None


def test_bad_key():
    with pytest.raises(ValueError):
        parse_key("H minor")
    with pytest.raises(ValueError):
        parse_key("13A")


def test_bpm_and_bars():
    assert format_bpm(140) == "140" and format_bpm(140.0) == "140" and format_bpm(128.5) == "128.5"
    assert format_bpm(99.999) == "100"
    assert bar_seconds(140) == pytest.approx(240 / 140)
    assert round(4 * bar_seconds(140) * 44100) == 302_400
