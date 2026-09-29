"""Regenerate checked-in game metadata in a staging folder, then replace it safely."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
FILES = (
    "product-metadata.json",
    "product-map.json",
    "mapping-audit.json",
    "product-pricing.json",
    "game-localization.json",
)


def run(*args: str) -> None:
    subprocess.run([sys.executable, *args], cwd=ROOT, check=True)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def validate(stage: Path) -> None:
    metadata = read_json(stage / "product-metadata.json")["products"]
    mappings = read_json(stage / "product-map.json")
    prices = read_json(stage / "product-pricing.json")["products"]
    catalog = read_json(stage / "game-localization.json")
    ids = [{int(row["productId"]) for row in rows} for rows in
           (metadata, mappings, prices, catalog["products"])]
    if not ids[0] or any(values != ids[0] for values in ids[1:]):
        raise ValueError("Regenerated metadata, mappings, pricing and localization ProductIDs differ")
    if any(len(values) != len(rows) for values, rows in zip(ids, (metadata, mappings, prices, catalog["products"]))):
        raise ValueError("Regenerated game data contains duplicate ProductIDs")
    if catalog.get("game", {}).get("steamBuildId") is None:
        raise ValueError("The generated localization catalog has no Steam build ID")
    if "ru-RU" not in catalog.get("availableLocales", []):
        raise ValueError("The installed game does not expose a Russian localization table")
    if not any(row.get("localization", {}).get("russian") for row in catalog["products"]):
        raise ValueError("No Russian product names were extracted")


def replace_data(stage: Path) -> None:
    backup = stage / "previous-data"
    backup.mkdir()
    for name in FILES:
        shutil.copy2(DATA / name, backup / name)
    replaced: list[str] = []
    try:
        for name in FILES:
            os.replace(stage / name, DATA / name)
            replaced.append(name)
    except Exception:
        for name in reversed(replaced):
            shutil.copy2(backup / name, DATA / name)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-data", type=Path, required=True, help="Path to Supermarket Simulator_Data")
    parser.add_argument("--reference-save", type=Path, required=True, help="Save slot used to scope the mapping audit")
    parser.add_argument("--csv", type=Path, default=ROOT / "supermarket-tracker-template.csv")
    args = parser.parse_args()
    game_data = args.game_data.resolve()
    save = args.reference_save.resolve()
    csv_path = args.csv.resolve()
    if not game_data.is_dir() or not (game_data / "StreamingAssets" / "aa").is_dir():
        parser.error("--game-data must name the installed game _Data directory")
    if not save.is_file() or not csv_path.is_file():
        parser.error("--reference-save and --csv must be existing files")

    with tempfile.TemporaryDirectory(prefix="smtracker-refresh-", dir=ROOT) as temporary:
        stage = Path(temporary)
        shutil.copy2(DATA / "product-map-overrides.json", stage / "product-map-overrides.json")
        common = ("--game-data", str(game_data), "--save", str(save), "--output", str(stage))
        run("tools/build-mapping-audit.py", *common, "--csv", str(csv_path), "--extract-only")
        run("tools/build-mapping-audit.py", *common, "--csv", str(csv_path), "--use-metadata")
        run("tools/extract-product-pricing.py", str(game_data), "--metadata",
            str(stage / "product-metadata.json"), "--output", str(stage / "product-pricing.json"))
        run("tools/extract-game-localization.py", "--game-root", str(game_data.parent),
            "--product-metadata", str(stage / "product-metadata.json"),
            "--product-map", str(stage / "product-map.json"),
            "--output", str(stage / "game-localization.json"))
        validate(stage)
        replace_data(stage)
        catalog = read_json(DATA / "game-localization.json")
        print(f"Updated {len(catalog['products'])} products from Steam build {catalog['game']['steamBuildId']}.")
        print(f"Russian labels: {catalog['coverage']['localizedProductLabels']}/"
              f"{catalog['coverage']['confirmedProducts']} confirmed products.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Game data refresh failed; checked-in files were not replaced: {error}", file=sys.stderr)
        raise SystemExit(1)
