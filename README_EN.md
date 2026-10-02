# Supermarket Simulator Profit Tracker + Auto Sync

An unofficial profit tracker for [Supermarket Simulator](https://store.steampowered.com/app/2670630/Supermarket_Simulator/). Compare purchase and selling prices, estimate profit, and bring game save data into the browser-based tracker. A separate Windows helper reads saves for automatic synchronization.

![Tracker overview](Assets/SupermarketSimulatorProfitTracker_v2_9.gif)

## Features

- Automatically finds and **reads game saves without writing to them**. The helper does not modify saves, game files, or the running game process.
- **Review Changes** and **Auto Sync**, plus **Undo Last Sync** for the most recent automatic batch. Review proposed changes before applying them for the first time.
- Separate fields for supplier unit cost, online box cost, average inventory cost, market price, player selling price, and pickup purchase price. Box cost is derived from game data.
- Verified ProductID mappings and product status indicators: active, disabled, or unknown.
- Adjustable minimum profit per box and product filters.
- English and Russian interfaces. When compatible game files are available, the helper can display official Russian product names.
- CSV import and export, plus a complete JSON backup containing products, price history, and settings.
- Manual use of the original HTML tracker without the helper.

## Download and first launch

Download **SupermarketTrackerSync.exe** from the project's [latest GitHub release](https://github.com/Kalarono/Supermarket-Simulator-Profit-Tracker-Auto-Sync/releases/latest). The helper supports **Windows x64**. It is self-contained: you do not need to install .NET, Python, or Node.js, and administrator privileges are not required.

1. Close any previous instance of the helper.
2. Double-click `SupermarketTrackerSync.exe`. The tracker opens at **http://127.0.0.1:47831/**.
3. Check the selected save in **Game Sync**. If several slots are present, the helper suggests the most recently modified one.
4. Open **Review Changes** to inspect the proposed prices and product mappings. Download a complete backup before applying changes.
5. If you wish, enable **Auto Sync** after its separate confirmation. It pauses for review if the save slot changes, a save is incompatible, or a large batch of changes is detected.

To select a specific slot, start the EXE from PowerShell:

```powershell
.\SupermarketTrackerSync.exe --save "<full path to slot_0.es3>"
```

The helper accepts connections only on `127.0.0.1`. Check its status at [http://127.0.0.1:47831/status](http://127.0.0.1:47831/status). Tracker prices, history, and settings are stored in the browser, never written to the game save.

## Backups and moving existing data

A tracker opened as `file://` and one opened at `http://127.0.0.1:47831/` have separate browser storage. To move your existing data:

1. In the old tracker, choose **Backup → Download Backup**.
2. Open the tracker through the helper at `http://127.0.0.1:47831/`.
3. Choose **Backup → Restore** and select the downloaded JSON file.

Different browsers and ports also have separate storage. CSV export does not contain the full price history or all settings, so use a complete JSON backup for migration. Make a backup before clearing browser data.

## Manual mode

Open [supermarketSimulator-tracker_v2_9.html](supermarketSimulator-tracker_v2_9.html) in a modern browser. If you copy the HTML file elsewhere, keep the [src](src) directory alongside it with the same relative path. To use Game Sync and official in-game product names, open the tracker through the localhost page provided by the helper.

## Compatibility and limitations

The helper has been tested with Supermarket Simulator save formats `v1.6.0(223)` and `v1.7.1(232)`. ProductID mappings and the localization catalog were prepared for these game versions. A game update may introduce an unknown format or product. In that case, the helper may prevent changes from being applied and fall back to English product names. Review ambiguous mappings before assigning them.

The original tracker loads charts and fonts from CDNs, so they may require an internet connection.

## Troubleshooting

- **Helper unavailable:** Start the EXE, open `http://127.0.0.1:47831/`, and close any older helper instance.
- **Save not found:** Save the game at least once. If needed, select a slot with `--save`.
- **Sync paused:** Open **Review Changes** and **View mapping issues** to inspect reading or mapping problems.
- **Old prices seem missing after switching to localhost:** Restore the complete JSON backup from the old browser storage.
- **Installed game was updated:** The helper retains its built-in product names and warns when they may differ from the installed game. Developers can refresh the catalog as described in [localization](docs/localization_EN.md).

The helper log is at `%LOCALAPPDATA%\SupermarketTrackerSync\logs\helper.log`. It may contain local save paths; remove personal information before posting it publicly. More details: [game synchronization](docs/game-sync_EN.md), [localization](docs/localization_EN.md), and [troubleshooting](docs/troubleshooting_EN.md).

## Build and tests

Development requires the .NET 8 SDK, Node.js, and Python. To make a local release build:

```powershell
dotnet publish src/SupermarketTrackerSync/SupermarketTrackerSync.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist/SupermarketTrackerSync-1.0.0
```

The `dist/` directory is excluded from Git. A release directory should contain only the EXE. Automated tests are in [tests](tests); ProductID and localization tools are in [tools](tools).

## Credits and license

This project is based on [Erebes666/supermarket-simulator-profit-tracker](https://github.com/Erebes666/supermarket-simulator-profit-tracker). The original tracker, CSV, images, MIT license, and Erebes666 copyright notices are preserved in [LICENSE](LICENSE). Auto Sync and localization extend the original project.

This is an unofficial fan project. It is neither affiliated with nor endorsed by Nokta Games. Supermarket Simulator and its game content belong to their respective owners.
