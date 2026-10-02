# Game synchronization

The Windows helper reads a selected Supermarket Simulator `.es3` save and serves the tracker at `http://127.0.0.1:47831/`. It waits for the game to finish writing the file and retains the last valid snapshot if reading temporarily fails. It does not modify the save, game files, or running game process. Its HTTP server accepts connections only on `127.0.0.1` and exposes read-only data routes.

## First launch

1. Run `SupermarketTrackerSync.exe` and check the selected save in **Game Sync**.
2. Open **Review Changes** to inspect verified ProductID matches and every proposed price change. Unmatched or ambiguous products appear under **View mapping issues**.
3. Download a complete JSON backup before applying changes or enabling Auto Sync.
4. Enable **Auto Sync** after confirmation. Automatic application pauses for review if a large batch changes, the save slot or mappings change, the snapshot is invalid, or the price schema is outdated.
5. **Undo Last Sync** reverts the latest Auto Sync batch if doing so would not overwrite later manual edits. The undone snapshot is not reapplied until a new game save appears.

A snapshot with the same file name, write time, and SHA-256 hash is applied at most once. Missing values in a save do not erase tracker data.

## Price fields

| Tracker field | Source or calculation |
| --- | --- |
| Supplier unit cost | Current product price in `PricingDatas` |
| Online box cost | Supplier unit cost × units per box from ProductSO |
| Average inventory cost | Current inventory cost from `AverageCosts`, when available |
| Market price | Supplier price and optimal profit rate from ProductSO, rounded according to game rules |
| Player selling price | `PricesSetByPlayer`, when available |
| Pickup purchase price | Entered manually in the tracker and preserved during sync |

The product status dot is based on `LicenseProductsDatas` and the game's license mappings: green means active, red means disabled, and gray means the status cannot be determined reliably. The minimum profit threshold only filters the tracker display. It does not change the save or synchronization rules.

## Data and compatibility

The EXE bundles the tracker HTML, scripts, ProductID mappings, pricing data, and localization catalog. Applied changes are still stored in your browser. When moving from `file://` to the helper's localhost address, use **Backup → Download Backup** followed by **Backup → Restore** because those pages have separate browser storage.

The parser has been tested with save versions `v1.6.0(223)` and `v1.7.1(232)`. If the game changes its save format or adds ProductIDs, verify the mappings before updating metadata. The helper provides `/status`, `/snapshot`, `/mapping-audit`, and localization routes on its local address. `--version` reports the helper, API schema, and mapping versions; `--inspect-localization` checks installed localization files.
