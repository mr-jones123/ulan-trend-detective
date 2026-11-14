"""Print the project's headline results from the built data file, paced for the demo video.

Every number is read from public/data/philippines-rainfall.json. Written with
Claude Code (Claude Opus 5.5), an SI tool, for the NASA Space Apps demo.
Run: python3 demo/highlights.py  (add --fast to skip the pauses)
"""
import json
import sys
import time
from pathlib import Path

A = json.loads((Path(__file__).resolve().parent.parent / "public/data/philippines-rainfall.json").read_text())
FAST = "--fast" in sys.argv
B, DIM, Y, G, R0 = "\033[1m", "\033[2m", "\033[33m", "\033[32m", "\033[0m"
BARS = " ▁▂▃▄▅▆▇█"
MINUS = "−"


def say(text="", pause=0.35):
    print(text, flush=True)
    if not FAST:
        time.sleep(pause)


def pct(v):
    return f"{'+' if v > 0 else MINUS if v < 0 else ''}{abs(v):.1f}%"


def bar(v, top, width=24):
    return "█" * max(1, round(width * v / top))


n, f, c = A["national"], A["farm"], A["climate"]
ja = n["jan_apr"]["enso"]
say(f"{B}Ulan, measured{R0} {DIM}· NASA rainfall over the Philippines, {A['period']['start']}-{A['period']['end']}{R0}")
say(f"{DIM}{A['cells']['count']:,} IMERG squares · {len(A['period']['years'])} years · {len(A['regions'])} regions · {len(f['sites'])} farm sites{R0}", 0.9)

say(f"\n{B}{Y}El Niño-start years, January to April rain{R0}")
top = ja["other_mean_mm"]
say(f"  {ja['group_size']} El Niño-start years  {ja['mean_mm']:>4.0f} mm  {Y}{bar(ja['mean_mm'], top)}{R0}")
say(f"  {ja['other_size']} other years         {ja['other_mean_mm']:>4.0f} mm  {bar(ja['other_mean_mm'], top)}")
say(f"  {B}{pct(ja['diff_pct'])}{R0}, and {ja['below_mean']} of {ja['group_size']} were below average", 1.2)

say(f"\n{B}{Y}Is it a trend? Sen's slope + Mann-Kendall test{R0}")
air = A["air"]["national"]["annual"]
verdict = lambda s: f"{G}meets the test{R0}" if s["meets_threshold"] else f"{DIM}could be chance{R0}"
say(f"  national rain   {pct(n['sen_pct_decade'])} per decade   p = {n['p']:.3f}   {verdict(n)}")
say(f"  air temperature +{air['sen_c_decade']:.2f} °C per decade  p < 0.001  {verdict(air)}", 1.2)

say(f"\n{B}{Y}Farm chain in El Niño-start years{R0} {DIM}(12 cropland sites){R0}")
say(f"  rain {pct(f['rain']['enso']['diff_pct'])} · days +{f['day']['enso_diff_c']:.2f} °C · greenness {MINUS}{abs(f['green']['enso_diff_ndvi']):.3f} NDVI at {f['green_lower_sites']}/12 sites", 1.0)

g = A["provenance"]["giovanni"]
say(f"\n{B}{Y}Checked against NASA Giovanni{R0}  r = {g['r']:.3f} · El Niño gap {pct(g['enso']['diff_pct'])} vs ours {pct(ja['diff_pct'])}", 1.2)

say(f"\n{B}{Y}k-means found {c['k']} rain calendars{R0} {DIM}(12 monthly shares per square, no map given){R0}")
peak = max(v for grp in c["groups"] for v in grp["month_share_pct"])
names = {"I": "Dry half-year    ", "III": "Short dry spell  ", "IV": "Even year-round  ", "II": "Wettest in winter"}
say(f"  {DIM}{'':27}JFMAMJJASOND  Jan-Apr  El Niño{R0}", 0.2)
for grp in c["groups"]:
    spark = "".join(BARS[min(8, max(1, round(8 * v / peak)))] for v in grp["month_share_pct"])
    say(f"  Type {grp['pagasa_type']:<4}{names[grp['pagasa_type']]} {spark}  {grp['jan_apr_share_pct']:>5.1f}%  {pct(grp['enso']['diff_pct'])}", 0.45)
say(f"  {DIM}settled after {c['iterations']} rounds · matches PAGASA climate Types I-IV{R0}", 1.0)
