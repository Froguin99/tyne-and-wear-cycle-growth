"""
Copy the dashboard into ./publish, ready to push to a GitHub Pages repo.

    python make_site.py                 # uses the public-site Carto key (see below)

The public site gets its OWN Carto key, restricted in the CARTO Basemaps dashboard to the GitHub Pages host
(<username>.github.io) and localhost. Don't reuse the cycleNodes key: that one is also used by locally opened HTML maps
and notebooks, which send no referrer and would stop loading tiles once the key is host-restricted.

Key lookup order: env CARTO_SITE_KEY, then ./site_carto_key.txt (keep that file out of any repo).

./publish can itself be a git clone of the Pages repo: everything except .git is replaced on each run.
"""
import json
import os
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "dashboard"
DST = HERE / "publish"
KEY_FILE = HERE / "site_carto_key.txt"

README = """# Expanding cycle networks with Low Traffic Neighbourhoods

Interactive explorer of bicycle network growth plans for the five Local Authority Districts of Tyne & Wear
(Newcastle upon Tyne, Gateshead, North Tyneside, South Tyneside, Sunderland).

Drag the slider to step through the growth stages, switch place and growth strategy, and click any link on the map to
see when it was added. The chart shows the per-stage metrics reported in the paper.

Generated from the analysis outputs of
[ltn-bikenetwork-growth](https://github.com/Froguin99/ltn-bikenetwork-growth).

Map data &copy; OpenStreetMap contributors (ODbL). Basemap &copy; CARTO.
"""


def main():
    key = os.environ.get("CARTO_SITE_KEY") or (KEY_FILE.read_text().strip() if KEY_FILE.exists() else "")
    if not key:
        raise SystemExit("No public-site Carto key: set CARTO_SITE_KEY or create site_carto_key.txt")

    DST.mkdir(exist_ok=True)
    for item in DST.iterdir():
        if item.name == ".git":
            continue
        shutil.rmtree(item) if item.is_dir() else item.unlink()

    for name in ("index.html", "app.js", "style.css"):
        shutil.copy2(SRC / name, DST / name)
    shutil.copytree(SRC / "lib", DST / "lib")
    shutil.copytree(SRC / "data", DST / "data", ignore=shutil.ignore_patterns("manifest_part.json"))

    (DST / "config.js").write_text(f"window.CARTO_API_KEY = {json.dumps(key)};\n", encoding="utf-8")
    (DST / ".nojekyll").write_text("", encoding="utf-8")  # serve files as-is, no Jekyll processing
    (DST / "README.md").write_text(README, encoding="utf-8")

    size = sum(f.stat().st_size for f in DST.rglob("*") if f.is_file() and ".git" not in f.parts)
    print(f"publish/ ready ({size / 1e6:.1f} MB). Test locally with:  python -m http.server 8000 --directory publish")


if __name__ == "__main__":
    main()
