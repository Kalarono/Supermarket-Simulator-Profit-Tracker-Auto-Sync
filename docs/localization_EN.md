# Localization

The tracker interface is available in **English** and **Russian**. Changing the language changes interface labels, but not ProductIDs, prices, mapping keys, history, or Auto Sync decisions. The language choice is stored in the browser and included in a complete JSON backup.

The helper serves product names through `/locales` and `/localization/ru-RU`, matching translations by ProductID and game table keys. Brand names remain as they appear in the game. The `isCurrent` field in `/locales` indicates whether the bundled catalog matches the installed game files. After an update, or when the game is absent, the tracker continues to show bundled names and warns that some translations may be outdated. If one product lacks a translation in a current catalog, other translations remain available. After a brief request failure, the browser keeps the last successfully loaded set until it can try again.

The standalone HTML tracker works manually without the helper. To display official game product names, open the tracker through the helper's localhost page. The helper only reads installed localization files.

Developers can regenerate consistent game data with `tools/refresh-game-data.py --game-data <path-to-Supermarket Simulator_Data> --reference-save <path-to-slot.es3>`. This rediscovers products, generates metadata, mappings, prices, and localization in a temporary directory, then verifies consistency before replacing files in `data`. The extractor must not reuse old Unity pathIds: they change between builds. For manual localization extraction, run `tools/extract-game-localization.py` with freshly generated `data/product-metadata.json` and `data/product-map.json`. Development dependencies are pinned in `requirements-dev.txt`.
