"""Read-only Unity Localization extractor for Supermarket Simulator.

Developer-time tool. Requires UnityPy 1.24.2 (the repository's .tools/asset-audit
environment). It reads the installed game's Addressables and the existing
ProductID metadata; it never writes to game assets or save files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

import UnityPy

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CONFIRMED = {"confirmed-exact", "confirmed-alias", "confirmed-metadata"}
SAMPLES = [33, 70, 73, 1, 28, 189, 210, 273, 274, 303, 311]


def read_steam_string(text: str, key: str) -> str | None:
    match = re.search(rf'"{re.escape(key)}"\s*"((?:\\.|[^"])*)"', text)
    return match.group(1).replace(r"\\", "\\") if match else None


def steam_roots() -> list[Path]:
    roots: list[Path] = []
    if os.name == "nt":
        try:
            import winreg

            for hive, key in (
                (winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
                (winreg.HKEY_LOCAL_MACHINE, r"Software\WOW6432Node\Valve\Steam"),
                (winreg.HKEY_LOCAL_MACHINE, r"Software\Valve\Steam"),
            ):
                try:
                    with winreg.OpenKey(hive, key) as handle:
                        value, _ = winreg.QueryValueEx(handle, "SteamPath")
                        roots.append(Path(value))
                except OSError:
                    pass
        except ImportError:
            pass
    for fallback in (Path.home() / ".steam/steam", Path.home() / ".local/share/Steam"):
        if fallback.exists():
            roots.append(fallback)

    libraries: list[Path] = []
    for root in roots:
        libraries.append(root)
        vdf = root / "steamapps/libraryfolders.vdf"
        if not vdf.is_file():
            continue
        for value in re.findall(r'"path"\s*"((?:\\.|[^"])*)"', vdf.read_text(encoding="utf-8", errors="replace")):
            library = Path(value.replace(r"\\", "\\"))
            if library not in libraries:
                libraries.append(library)
    return libraries


def discover_game(game_root: Path | None) -> tuple[Path, Path | None, str | None]:
    if game_root is not None:
        root = game_root.resolve()
        data = find_data_directory(root)
        if data is None:
            raise FileNotFoundError(f"No *_Data directory with StreamingAssets/aa found under {root}")
        return root, data, None

    candidates: list[tuple[Path, Path, str | None]] = []
    for library in steam_roots():
        manifests = library / "steamapps"
        if not manifests.is_dir():
            continue
        for manifest in manifests.glob("appmanifest_*.acf"):
            try:
                text = manifest.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if (read_steam_string(text, "name") or "").casefold() != "supermarket simulator":
                continue
            install_dir = read_steam_string(text, "installdir")
            build_id = read_steam_string(text, "buildid")
            if not install_dir:
                continue
            root = manifests / "common" / install_dir
            data = find_data_directory(root)
            if data is not None:
                candidates.append((root.resolve(), data, build_id))
    if not candidates:
        raise FileNotFoundError("Supermarket Simulator was not found in the Steam libraries listed by Steam metadata")
    return candidates[0]


def find_data_directory(root: Path) -> Path | None:
    if (root / "StreamingAssets/aa").is_dir():
        return root
    if not root.is_dir():
        return None
    for path in root.glob("*_Data"):
        if (path / "StreamingAssets/aa").is_dir():
            return path
    return None


def aligned_string(raw: bytes, offset: int) -> tuple[str, int]:
    if offset + 4 > len(raw):
        raise ValueError("truncated serialized string")
    size = struct.unpack_from("<i", raw, offset)[0]
    if size < 0 or size > 4096 or offset + 4 + size > len(raw):
        raise ValueError("invalid serialized string length")
    return raw[offset + 4:offset + 4 + size].decode("utf-8"), (offset + 4 + size + 3) & ~3


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_shared_tables(path: Path) -> tuple[dict[str, dict], dict[int, dict]]:
    env = UnityPy.load(str(path))
    by_guid: dict[str, dict] = {}
    by_path: dict[int, dict] = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        guid = tree.get("m_TableCollectionNameGuidString")
        name = tree.get("m_TableCollectionName")
        if not guid or not name:
            continue
        table = {
            "name": name,
            "guid": guid,
            "pathId": obj.path_id,
            "entries": {int(row["m_Id"]): row["m_Key"] for row in tree.get("m_Entries", [])},
        }
        by_guid[guid] = table
        by_path[obj.path_id] = table
    if not by_guid:
        raise ValueError(f"No Unity Localization Shared Tables found in {path.name}")
    return by_guid, by_path


def load_locale_tables(folder: Path, shared_by_path: dict[int, dict]) -> tuple[dict, dict]:
    tables: dict[tuple[str, str], dict[int, str]] = {}
    counts: dict[str, int] = {}
    for bundle in sorted(folder.glob("localization-string-tables-*_assets_all.bundle")):
        env = UnityPy.load(str(bundle))
        found_in_bundle = 0
        for obj in env.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            try:
                tree = obj.read_typetree()
            except Exception:
                continue
            locale_id = tree.get("m_LocaleId") or {}
            locale = locale_id.get("m_Code")
            shared_ref = tree.get("m_SharedData") or {}
            shared = shared_by_path.get(shared_ref.get("m_PathID"))
            if not locale or shared is None or "m_TableData" not in tree:
                continue
            values = {
                int(row["m_Id"]): row.get("m_Localized", "")
                for row in tree.get("m_TableData", [])
            }
            tables[(locale, shared["guid"])] = values
            counts[locale] = counts.get(locale, 0) + 1
            found_in_bundle += 1
        if found_in_bundle == 0:
            raise ValueError(f"No localization string tables parsed from {bundle.name}")
    if "en" not in counts or "ru-RU" not in counts:
        raise ValueError(f"Required locales missing; detected {sorted(counts)}")
    return tables, counts


def load_product_rows(metadata_path: Path, mapping_path: Path, game_data: Path,
                      shared_by_guid: dict, locale_tables: dict) -> tuple[list[dict], dict]:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    mapping_rows = json.loads(mapping_path.read_text(encoding="utf-8"))
    mappings = {int(row["productId"]): row for row in mapping_rows}
    meta_rows = metadata.get("products", [])
    by_file: dict[str, list[dict]] = {}
    for row in meta_rows:
        by_file.setdefault(row["assetFile"], []).append(row)

    products: list[dict] = []
    for relative_file, rows in sorted(by_file.items()):
        asset_path = game_data / relative_file
        if not asset_path.is_file():
            raise FileNotFoundError(f"Product asset metadata is stale; missing {asset_path}")
        expected = {int(row["pathId"]): row for row in rows}
        env = UnityPy.load(str(asset_path))
        seen: set[int] = set()
        for obj in env.objects:
            meta = expected.get(obj.path_id)
            if meta is None:
                continue
            raw = obj.get_raw_data()
            name, after_name = aligned_string(raw, 28)
            offset = (32 + len(name.encode("utf-8")) + 3) & ~3
            product_id = struct.unpack_from("<i", raw, offset)[0]
            category, cursor = aligned_string(raw, offset + 4)
            table_guid, cursor = aligned_string(raw, cursor)
            if not table_guid.startswith("GUID:"):
                raise ValueError(f"Unsupported ProductSO localization reference for ProductID {product_id}")
            key_id = struct.unpack_from("<q", raw, cursor)[0]
            brand, _ = aligned_string(raw, cursor + 24)
            if product_id != int(meta["productId"]) or name != meta["assetName"]:
                raise ValueError(f"Product metadata does not match installed assets at pathId {obj.path_id}")
            seen.add(product_id)
            guid = table_guid.removeprefix("GUID:")
            shared = shared_by_guid.get(guid)
            key = shared["entries"].get(key_id) if shared else None
            table_name = shared["name"] if shared else None
            entry = {
                "productId": product_id,
                "assetName": name,
                "canonical": {
                    "category": category,
                    "brand": brand or None,
                    "displayName": f"{category} - {brand}" if brand else category,
                },
                "localization": {
                    "table": table_name,
                    "key": key,
                    "id": key_id,
                    "english": locale_tables.get(("en", guid), {}).get(key_id) or None,
                    "russian": locale_tables.get(("ru-RU", guid), {}).get(key_id) or None,
                    "source": "game-localization",
                },
                "mappingStatus": mappings.get(product_id, {}).get("auditStatus", "unmapped"),
            }
            localized = entry["localization"]
            localized["englishDisplayName"] = (
                f"{localized['english']} - {brand}" if localized["english"] and brand else localized["english"]
            )
            localized["russianDisplayName"] = (
                f"{localized['russian']} - {brand}" if localized["russian"] and brand else localized["russian"]
            )
            localized["brandLocalized"] = None
            if key is None:
                entry["localization"]["warning"] = "ProductSO localization key was not found in Shared Table metadata"
            products.append(entry)
        if len(seen) != len(expected):
            raise ValueError(f"Product metadata contains objects absent from {relative_file}: {len(expected)-len(seen)}")
    return sorted(products, key=lambda row: row["productId"]), mappings


def make_catalog(game_root: Path | None, metadata_path: Path, mapping_path: Path,
                 output_path: Path | None) -> tuple[dict, dict]:
    root, game_data, steam_build = discover_game(game_root)
    assert game_data is not None
    streaming = game_data / "StreamingAssets/aa"
    target = streaming / "StandaloneWindows64"
    shared_file = target / "localization-assets-shared_assets_all.bundle"
    locales_file = target / "localization-locales_assets_all.bundle"
    for path in (shared_file, locales_file):
        if not path.is_file():
            raise FileNotFoundError(f"Required Addressables bundle is missing: {path}")

    shared_by_guid, shared_by_path = load_shared_tables(shared_file)
    locale_tables, locale_counts = load_locale_tables(target, shared_by_path)
    products, mapping_rows = load_product_rows(metadata_path, mapping_path, game_data, shared_by_guid, locale_tables)

    required_bundles = [shared_file, locales_file]
    for locale_name, marker in (("en", "localization-string-tables-english"), ("ru-RU", "localization-string-tables-russian")):
        matches = sorted(target.glob(marker + "*_assets_all.bundle"))
        if not matches:
            raise FileNotFoundError(f"Required {locale_name} localization table bundle is missing")
        required_bundles.extend(matches)
    bundle_files = []
    for path in required_bundles:
        stat = path.stat()
        bundle_files.append({
            "name": path.name,
            "length": stat.st_size,
            "lastWriteTimeUtc": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat().replace("+00:00", "Z"),
            "sha256": file_hash(path),
        })
    product_files = []
    for relative in sorted({row["assetFile"] for row in json.loads(metadata_path.read_text(encoding="utf-8"))["products"]}):
        path = game_data / relative
        stat = path.stat()
        product_files.append({
            "name": relative,
            "length": stat.st_size,
            "lastWriteTimeUtc": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat().replace("+00:00", "Z"),
        })
    fingerprint_material = json.dumps({
        "steamBuildId": steam_build,
        "bundleFiles": [{"name": x["name"], "sha256": x["sha256"]} for x in bundle_files],
        "productFiles": product_files,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")
    fingerprint = hashlib.sha256(fingerprint_material).hexdigest()

    table_entries = sum(len(table["entries"]) for table in shared_by_guid.values())
    confirmed = [row for row in products if row["mappingStatus"] in CONFIRMED]
    available_ru = [row for row in confirmed if row["localization"]["russian"]]
    fallback = [row for row in confirmed if not row["localization"]["russian"]]
    catalog = {
        "schemaVersion": 1,
        "source": "game-localization",
        "game": {
            "name": "Supermarket Simulator",
            "steamBuildId": steam_build,
            "gameVersion": None,
        },
        "cache": {
            "fingerprint": "sha256:" + fingerprint,
            "bundleFiles": bundle_files,
            "productAssetFiles": product_files,
        },
        "detectedLocales": sorted(locale_counts),
        "availableLocales": ["en", "ru-RU"],
        "tables": {
            "sharedTableCount": len(shared_by_guid),
            "sharedKeyCount": table_entries,
            "localeTableCounts": locale_counts,
            "productRelatedKeys": sum(len(t["entries"]) for t in shared_by_guid.values()
                                       if t["name"] in {"Products", "DLC_Bakery", "DLC_IceCream"}),
        },
        "coverage": {
            "confirmedProducts": len(confirmed),
            "localizedProductLabels": len(available_ru),
            "categoryLocalized": len([row for row in confirmed
                                       if row["localization"]["table"] == "Products" and row["localization"]["russian"]]),
            "brandLocalized": 0,
            "fallbackEnglish": len(fallback),
            "gameOnlyBakeryBaked": sum(1 for row in products if row["mappingStatus"] == "bakery-baked"),
            "ambiguous": sum(1 for row in products if row["mappingStatus"] == "ambiguous"),
        },
        "products": products,
    }
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    report = {
        "discoveredGame": str(root),
        "gameData": str(game_data),
        "steamBuildId": steam_build,
        "localizationLanguages": catalog["detectedLocales"],
        "stringTablesPerLocale": locale_counts,
        "sharedStringTables": len(shared_by_guid),
        "sharedKeys": table_entries,
        "productRelatedKeys": catalog["tables"]["productRelatedKeys"],
        "coverage": catalog["coverage"],
        "productMapCount": len(mapping_rows),
        "samples": [row for row in products if row["productId"] in SAMPLES],
        "output": str(output_path) if output_path else None,
    }
    return catalog, report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-root", type=Path, help="Optional explicit game install root; default discovers Steam libraries")
    parser.add_argument("--product-metadata", type=Path, default=Path("data/product-metadata.json"))
    parser.add_argument("--product-map", type=Path, default=Path("data/product-map.json"))
    parser.add_argument("--output", type=Path, help="Write the generated JSON catalog; omit for inspect-only mode")
    args = parser.parse_args()
    try:
        _, report = make_catalog(args.game_root, args.product_metadata, args.product_map, args.output)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
