"""File writer: WAV header bytes (CDJ E-8305), tags read back, dither, filenames and versions."""
import json
import struct

import numpy as np
import pytest
import soundfile as sf
from mutagen.aiff import AIFF

from fvwks_server.writer import (
    DEFAULT_PATTERN,
    RENDER_TXXX,
    ExportItem,
    ExportMeta,
    FileNaming,
    TrackTags,
    cover_art,
    export_files,
    folder_name,
    normalize_wav,
    quantize,
    read_riff_info,
    read_tags,
    next_version,
    safe_path,
    slugify,
    validate_pattern,
    variant_token,
    wav_format_tag,
    write_track,
)

SR = 44100
FRAMES_4BAR_140 = 302_400  # 4 bars at 140 BPM, 44.1 kHz: 4 * 240/140 * 44100
SCRIPT = "WE ARE GUY FVWKS | EXPECT *US*"


def tone(frames=FRAMES_4BAR_140, channels=2, amp=0.5, freq=110.0):
    t = np.arange(frames) / SR
    mono = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    return np.stack([mono] * channels)  # channels-first, like fvwks_fx


def meta(**kw):
    base = dict(script=SCRIPT, preset="PACT", bpm=140, bars=4, key="Am", render_params={"macros": {"depth": 0.7}})
    base.update(kw)
    return ExportMeta(**base)


# --------------------------------------------------------------------------------------------- WAV header


@pytest.mark.parametrize("bit_depth,channels", [(24, 2), (16, 2), (24, 1)])
def test_wav_is_integer_pcm_with_canonical_header(tmp_path, bit_depth, channels):
    [out] = export_files(tmp_path, meta(), [ExportItem("wet", tone(channels=channels), SR)], fmt="wav",
                         bit_depth=bit_depth, channels=channels)
    raw = out.path.read_bytes()
    assert raw[0:4] == b"RIFF" and raw[8:12] == b"WAVE"
    assert struct.unpack_from("<I", raw, 4)[0] == len(raw) - 8
    assert raw[12:16] == b"fmt " and struct.unpack_from("<I", raw, 16)[0] == 16
    # CDJs reject WAVE_FORMAT_EXTENSIBLE (0xFFFE) with E-8305: bytes 20-21 must be 0x0001.
    assert raw[20:22] == b"\x01\x00"
    tag, ch, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", raw, 20)
    assert (tag, ch, rate, bits) == (1, channels, SR, bit_depth)
    assert align == channels * bit_depth // 8 and byte_rate == SR * align
    assert raw[36:40] == b"data"  # canonical 44-byte header; INFO follows the audio
    assert struct.unpack_from("<I", raw, 40)[0] == FRAMES_4BAR_140 * align
    info = sf.info(str(out.path))
    assert info.frames == FRAMES_4BAR_140 and info.subtype == f"PCM_{bit_depth}"


def test_extensible_header_is_rewritten_to_pcm(tmp_path):
    path = tmp_path / "x.wav"
    rng = np.random.default_rng(1)
    pcm = (rng.integers(-(2**23), 2**23, size=(1001, 2)) << 8).astype(np.int32)  # odd frame count
    sf.write(path, pcm, 48000, subtype="PCM_24", format="WAVEX")
    assert wav_format_tag(path) == 0xFFFE
    normalize_wav(path, {"INAM": "fixed"})
    assert wav_format_tag(path) == 0x0001
    back, rate = sf.read(path, dtype="int32")
    assert rate == 48000 and np.array_equal(back, pcm)
    assert read_riff_info(path) == {"INAM": "fixed"}


def test_float_wav_is_refused(tmp_path):
    path = tmp_path / "f.wav"
    sf.write(path, np.zeros((10, 2), np.float32), SR, subtype="FLOAT", format="WAV")
    with pytest.raises(ValueError, match="integer PCM"):
        normalize_wav(path)


# --------------------------------------------------------------------------------------------- tags


def test_aiff_id3v23_tags_read_back(tmp_path):
    [out] = export_files(tmp_path, meta(), [ExportItem("wet", tone(), SR)])
    assert out.filename == "we-are-guy-fvwks_PACT_140bpm_4bar_Am_wet_v01.aiff"
    raw = out.path.read_bytes()
    assert raw[:4] == b"FORM" and raw[8:12] == b"AIFF"
    id3_at = raw.index(b"ID3 ")
    assert raw[id3_at + 8 : id3_at + 12] == b"ID3\x03"  # ID3v2.3 header inside the chunk

    tags = AIFF(str(out.path)).tags
    assert tags.version == (2, 3, 0)
    assert tags["TIT2"].text == ["WE ARE GUY FVWKS EXPECT US (PACT v01)"]
    assert tags["TPE1"].text == ["GUY FVWKS"]
    assert tags["TBPM"].text == ["140"]
    assert tags["TKEY"].text == ["Am"]
    comment = tags.getall("COMM")[0].text[0]
    assert "PACT" in comment and SCRIPT in comment
    params = json.loads(tags[f"TXXX:{RENDER_TXXX}"].text[0])
    assert params["render"] == {"macros": {"depth": 0.7}}
    assert params | {"render": None} == {"variant": "wet", "version": 1, "preset": "PACT", "script": SCRIPT,
                                         "bpm": 140, "bars": 4, "key": "Am", "render": None}
    info = sf.info(str(out.path))
    assert (info.frames, info.samplerate, info.channels, info.subtype) == (FRAMES_4BAR_140, SR, 2, "PCM_24")


def jpeg_frame(data: bytes) -> tuple[int, int, int]:
    """(SOF marker, width, height) of a JPEG; marker 0xC0 is baseline, 0xC2 progressive."""
    pos = 2
    while pos + 9 <= len(data):
        marker, size = data[pos + 1], struct.unpack_from(">H", data, pos + 2)[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack_from(">HH", data, pos + 5)
            return marker, width, height
        pos += 2 + size
    raise AssertionError("no SOF marker")


def test_every_aiff_carries_the_fox_cover(tmp_path):
    art = cover_art()
    assert art[:3] == b"\xff\xd8\xff" and len(art) < 150_000
    assert jpeg_frame(art) == (0xC0, 600, 600)  # baseline 600x600
    items = [ExportItem("wet", tone(4410), SR), ExportItem("dry", tone(4410), SR),
             ExportItem("alt:legion", tone(4410), SR), ExportItem("stem:sub", tone(4410), SR)]
    for out in export_files(tmp_path, meta(), items):
        tags = AIFF(str(out.path)).tags
        assert tags.version == (2, 3, 0)
        [apic] = tags.getall("APIC")
        assert (apic.type, apic.mime, apic.desc) == (3, "image/jpeg", "FoxBox") and apic.data == art
        assert read_tags(out.path)["id3"]["APIC:FoxBox"] == {"mime": "image/jpeg", "type": 3, "desc": "FoxBox",
                                                              "bytes": len(art)}
        assert tags["TIT2"].text and f"TXXX:{RENDER_TXXX}" in tags  # the other tags are still there
    [wav] = export_files(tmp_path, meta(), [ExportItem("wet", tone(4410), SR)], fmt="wav")
    assert b"ID3" not in wav.path.read_bytes()  # WAV stays RIFF INFO only
    [bare] = export_files(tmp_path / "bare", meta(cover=None), [ExportItem("wet", tone(4410), SR)])
    assert AIFF(str(bare.path)).tags.getall("APIC") == []


def test_wav_riff_info_read_back(tmp_path):
    [out] = export_files(tmp_path, meta(key="F# minor"), [ExportItem("wet", tone(), SR)], fmt="wav")
    info = read_riff_info(out.path)
    assert info["INAM"] == "WE ARE GUY FVWKS EXPECT US (PACT v01)"
    assert info["IART"] == "GUY FVWKS"
    assert info["ICMT"] == f"[PACT] {SCRIPT} (140 BPM, F#m)"
    assert {"IPRD", "ICRD", "ISFT"} <= set(info)
    with sf.SoundFile(str(out.path)) as f:  # libsndfile reads the same INFO chunk independently
        assert f.title == info["INAM"] and f.artist == "GUY FVWKS" and f.comment == info["ICMT"]
    assert read_tags(out.path)["info"] == info


def test_non_ascii_script_folds_in_riff_info(tmp_path):
    tags = TrackTags(title="Éxpect “us” — now", script="Éxpect", preset="PACT")
    path = tmp_path / "u.wav"
    write_track(path, tone(4410), SR, fmt="wav", tags=tags)
    assert read_riff_info(path)["INAM"] == 'Expect "us" - now'


# --------------------------------------------------------------------------------------------- samples


def test_24bit_round_trip_is_exact_to_half_an_lsb(tmp_path):
    rng = np.random.default_rng(7)
    audio = (rng.uniform(-0.9, 0.9, size=(2, 44100))).astype(np.float32)
    path = tmp_path / "a.aiff"
    track = write_track(path, audio, SR, fmt="aiff", bit_depth=24)
    back, _ = sf.read(path, dtype="float64")
    assert track.frames == 44100 and back.shape == (44100, 2)
    assert np.max(np.abs(back.T - audio.astype(np.float64))) <= 0.5 / 2**23 + 1e-12


def test_16bit_gets_tpdf_dither():
    lsb = 1 / 32768
    dc = np.full((200_000, 1), 0.25 * lsb)
    plain, _ = quantize(dc, 16, rng=None)
    assert not plain.any()  # without dither, a quarter-LSB signal vanishes
    dithered, _ = quantize(dc, 16, rng=np.random.default_rng(0))
    assert set(np.unique(dithered)) <= {-1, 0, 1}  # triangular noise spans ±1 LSB
    assert abs(dithered.mean() - 0.25) < 0.01  # and linearises the quantiser
    noise, _ = quantize(np.zeros((200_000, 1)), 16, rng=np.random.default_rng(0))
    # Silence through ±1 LSB triangular dither rounds to ±1 a quarter of the time (P(|d| > 0.5) = 1/4), so the
    # output variance is 1/4 LSB². Rectangular ±0.5 LSB dither would always round back to 0.
    assert abs(noise.var() - 0.25) < 0.01


def test_16bit_export_is_deterministic(tmp_path):
    a = export_files(tmp_path / "a", meta(), [ExportItem("wet", tone(), SR)], bit_depth=16)[0]
    b = export_files(tmp_path / "b", meta(), [ExportItem("wet", tone(), SR)], bit_depth=16)[0]
    assert sf.info(str(a.path)).subtype == "PCM_16"
    assert sf.read(a.path, dtype="int16")[0].tobytes() == sf.read(b.path, dtype="int16")[0].tobytes()


def test_clipping_is_counted(tmp_path):
    track = write_track(tmp_path / "c.wav", np.array([[1.5, -1.5, 0.0, 1.0]] * 2), SR, fmt="wav")
    assert track.clipped_samples == 6  # ±1.5 twice per channel, and +1.0 is one LSB past full scale


def test_mono_upmix_nan_and_shape_checks(tmp_path):
    track = write_track(tmp_path / "m.aiff", tone(channels=1)[0], SR)
    assert track.channels == 2
    with pytest.raises(ValueError, match="NaN"):
        write_track(tmp_path / "n.aiff", np.array([0.0, np.nan, 0.0]), SR)
    with pytest.raises(ValueError, match="channel"):
        write_track(tmp_path / "s.aiff", np.zeros((3, 1000)), SR)


# --------------------------------------------------------------------------------------------- names


def test_versions_are_shared_and_incremented(tmp_path):
    items = [ExportItem("wet", tone(), SR), ExportItem("dry", tone(), SR), ExportItem("alt:legion", tone(), SR),
             ExportItem("stem:Sub", tone(), SR)]
    first = export_files(tmp_path, meta(), items)
    assert [f.filename for f in first] == [
        "we-are-guy-fvwks_PACT_140bpm_4bar_Am_wet_v01.aiff",
        "we-are-guy-fvwks_PACT_140bpm_4bar_Am_dry_v01.aiff",
        "we-are-guy-fvwks_PACT_140bpm_4bar_Am_alt-LEGION_v01.aiff",
        "we-are-guy-fvwks_PACT_140bpm_4bar_Am_stem-sub_v01.aiff",
    ]
    assert [f.title for f in first] == [
        "WE ARE GUY FVWKS EXPECT US (PACT v01)", "WE ARE GUY FVWKS EXPECT US (PACT dry v01)",
        "WE ARE GUY FVWKS EXPECT US (LEGION v01)", "WE ARE GUY FVWKS EXPECT US (PACT stem Sub v01)",
    ]
    second = export_files(tmp_path, meta(), [ExportItem("dry", tone(), SR)], fmt="wav")
    assert second[0].filename == "we-are-guy-fvwks_PACT_140bpm_4bar_Am_dry_v02.wav"
    other = export_files(tmp_path, meta(bpm=128.5, bars=None, key=None), [ExportItem("wet", tone(), SR)])
    assert other[0].filename == "we-are-guy-fvwks_PACT_128.5bpm_free_wet_v01.aiff"
    assert not list(tmp_path.glob(".*"))  # no staging leftovers


def test_failed_export_leaves_nothing_behind(tmp_path):
    bad = tone()
    bad[0, 100] = np.nan
    with pytest.raises(ValueError):
        export_files(tmp_path, meta(), [ExportItem("wet", tone(), SR), ExportItem("dry", bad, SR)])
    assert list(tmp_path.iterdir()) == []
    with pytest.raises(ValueError, match="duplicate"):
        export_files(tmp_path, meta(), [ExportItem("alt:X", tone(), SR), ExportItem("alt:x", tone(), SR)])


def test_name_overrides_slug_and_title(tmp_path):
    [out] = export_files(tmp_path, meta(name="Intro Drop #1"), [ExportItem("wet", tone(4410), SR)])
    assert out.filename.startswith("intro-drop-1_PACT_140bpm")
    assert out.title == "Intro Drop #1 (PACT v01)"


def test_text_helpers():
    assert slugify(SCRIPT) == "we-are-guy-fvwks"
    assert slugify("[0.5] Don't  *stop* [2b] me | now") == "dont-stop-me-now"
    assert slugify("|||") == "untitled"
    assert variant_token("alt:legion") == "alt-LEGION" and variant_token("stem:Sub") == "stem-sub"
    assert FileNaming("my preset", "x", 174, 8, "Gb major").filename("stem:sub", 3, "wav") == \
        "x_MY-PRESET_174bpm_8bar_F#_stem-sub_v03.wav"
    assert folder_name("../../etc") == "etc" and folder_name("  ") == "Setlist"
    assert folder_name("Friday: Warehouse/Set") == "Friday- Warehouse-Set"


def test_safe_path_refuses_escapes(tmp_path):
    assert safe_path(tmp_path, "a", "b.aiff") == (tmp_path / "a" / "b.aiff").resolve()
    for bad in (("..", "x"), ("/etc/passwd",), ("a", "../../x")):
        with pytest.raises(ValueError):
            safe_path(tmp_path, *bad)


def test_custom_filename_patterns(tmp_path):
    naming = FileNaming("PACT", "we-are", 140, None, None, artist="Guy Fvwks",
                        pattern="{artist} {slug} [{preset}] {variant} #{version}")
    assert naming.filename("alt:legion", 7, "aiff") == "GUYFVWKS we-are [PACT] alt-LEGION #7.aiff"
    (tmp_path / "GUYFVWKS we-are [PACT] wet #12.wav").touch()
    (tmp_path / "GUYFVWKS we-are [RAW] wet #40.wav").touch()  # another export: not counted
    assert next_version(tmp_path, naming) == 13
    free = FileNaming("PACT", "x", 140, None, None)  # FREE bars, no key: no "freebar", no doubled "_"
    assert free.filename("wet", 1, "wav") == "x_PACT_140bpm_free_wet_v01.wav"
    assert FileNaming("P", "a/b", pattern="../{slug}:{variant}_{version}").filename("wet", 1, "wav") == \
        "a-b-wet_1.wav"  # separators become "-", leading dots are stripped
    assert validate_pattern(DEFAULT_PATTERN) == DEFAULT_PATTERN
    for bad in ("{slug}_{version}", "{slug}_{variant}", "{slug}_{nope}_{variant}_{version}", "{0}{variant}{version}",
                "{variant}_{version:zz}"):
        with pytest.raises(ValueError):
            validate_pattern(bad)


def test_concurrent_exports_reserve_versions_without_blocking(tmp_path, monkeypatch):
    import threading

    from fvwks_server import writer

    real, entered, release = writer.write_track, threading.Event(), threading.Event()

    def slow_in_one_thread(path, *args, **kwargs):
        if threading.current_thread().name == "slow-export":
            entered.set()
            release.wait(5)
        return real(path, *args, **kwargs)

    monkeypatch.setattr(writer, "write_track", slow_in_one_thread)
    results = {}
    slow = threading.Thread(name="slow-export", target=lambda: results.setdefault(
        "slow", export_files(tmp_path, meta(), [ExportItem("wet", tone(4410), SR)])))
    slow.start()
    assert entered.wait(5)
    fast = export_files(tmp_path, meta(), [ExportItem("wet", tone(4410), SR)])  # doesn't wait for the slow one
    assert not results  # the slow export is still encoding
    release.set()
    slow.join(5)
    assert (results["slow"][0].version, fast[0].version) == (1, 2)
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "we-are-guy-fvwks_PACT_140bpm_4bar_Am_wet_v01.aiff",
        "we-are-guy-fvwks_PACT_140bpm_4bar_Am_wet_v02.aiff"]


def test_failed_export_releases_its_version(tmp_path):
    bad = tone(4410)
    bad[0, 10] = np.nan
    with pytest.raises(ValueError):
        export_files(tmp_path, meta(), [ExportItem("wet", bad, SR)])
    [ok] = export_files(tmp_path, meta(), [ExportItem("wet", tone(4410), SR)])
    assert ok.version == 1
