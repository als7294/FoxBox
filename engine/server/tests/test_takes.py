import numpy as np
from fvwks_contracts.models import RemixPrefs, TakeChoice, TakeFeedback

from fvwks_server.takes import chooser, prefs_from, shares

DRUMS = {"whack": 0.5, "seesaw": 0.35, "backbeat": 0.15}  # plan v2 §7.3's worked example (AX-14)


def fb(seed, rating, option, tags=(), remix="rmx_a"):
    return TakeFeedback(id=f"f{seed}{rating}", remix_id=remix, seed=seed, style="riddim", rating=rating, tags=list(tags),
                        choices=[TakeChoice(axis="riddim.drums", option=option), TakeChoice(axis="mix.ott", option="faust")],
                        created_at="2026-09-29T00:00:00Z")


def test_each_take_counts_once_from_its_latest_rating_with_tag_scoped_blame():
    rows = [fb(1, 1, "whack"), fb(2, 1, "whack"), fb(3, 1, "whack"), fb(4, -1, "whack", ["rhythm"]),
            fb(5, -1, "seesaw", ["sounds_like_trap"]), fb(6, -1, "seesaw", ["sounds_like_trap"]),
            fb(7, 1, "backbeat"), fb(8, -1, "backbeat", ["mix"]), fb(9, 1, "seesaw"), fb(9, 0, "seesaw")]
    p = prefs_from(rows, "riddim")
    got = {(a.axis, o.option): (o.up, o.down) for a in p.axes for o in a.options}
    assert p.ratings == 8  # take 9 withdrew
    assert got[("riddim.drums", "whack")] == (3, 1) and got[("riddim.drums", "seesaw")] == (0, 2)
    assert got[("riddim.drums", "backbeat")] == (1, 0.25)  # 'mix' doesn't blame the drums: 0.25
    assert got[("mix.ott", "faust")] == (4, 3 * 0.25 + 1)  # rhythm and trap x2 spare mix.ott (0.25 each); mix blames it
    assert prefs_from([fb(1, -1, "whack")], "riddim").axes[0].options[0].down == 0.5  # no tags: 0.5 everywhere


def test_the_draw_is_weighted_thompson_with_a_floor_and_a_take_replays():
    theta = np.array([0.58, 0.31, 0.74])  # §7.3's one ROLL
    assert np.allclose(shares(np.array([0.5, 0.35, 0.15]), theta), [0.569, 0.213, 0.218], atol=0.002)
    assert shares(np.array([1.0, 0.0]), np.array([0.5, 0.5]))[1] == 0  # weight 0 stays off (declared, inactive)
    assert shares(np.array([0.99, 0.01]), np.array([0.9, 0.1])).min() >= 0.045  # the 5 % floor keeps it alive
    rated = prefs_from([fb(1, 1, "whack"), fb(2, 1, "whack"), fb(3, 1, "whack"), fb(4, -1, "whack", ["rhythm"]),
                        fb(5, -1, "seesaw", ["sounds_like_trap"]), fb(6, -1, "seesaw", ["sounds_like_trap"]),
                        fb(7, 1, "backbeat"), fb(8, -1, "backbeat", ["mix"])], "riddim")
    draws = [chooser(s, [], [rated])[0]("riddim.drums", DRUMS) for s in range(3000)]
    share = {k: draws.count(k) / 3000 for k in DRUMS}
    assert share["whack"] > 0.55 and share["seesaw"] < 0.25, share  # 0.50 → ~0.65 and 0.35 → ~0.17 (§7.3)
    assert draws == [chooser(s, [], [rated])[0]("riddim.drums", DRUMS) for s in range(3000)]  # (seed, axis, prefs) fixed
    choose, made = chooser(5, [TakeChoice(axis="riddim.drums", option="backbeat")], [rated])
    assert choose("riddim.drums", DRUMS) == "backbeat" and made == {"riddim.drums": "backbeat"}
    assert RemixPrefs(style="x").ratings == 0


def test_weight_zero_options_are_never_drawn():
    rated = prefs_from([fb(s, 1, "seesaw") for s in range(1, 9)], "riddim")  # even heavily liked
    axis = {"whack": 0.6, "seesaw": 0.0, "backbeat": 0.4}
    assert "seesaw" not in {chooser(s, [], [rated])[0]("riddim.drums", axis) for s in range(500)}
    assert np.allclose(shares(np.zeros(2), np.array([0.5, 0.5])), [0.5, 0.5])  # all inactive: no crash
