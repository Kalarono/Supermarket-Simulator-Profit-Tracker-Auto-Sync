# Troubleshooting

| Symptom | What to check |
| --- | --- |
| Helper unavailable | Run `SupermarketTrackerSync.exe`, close any older instance, and open `http://127.0.0.1:47831/`. |
| Save not found | Save the game at least once, check the selected slot, or start the helper with `--save "<full path to slot_0.es3>"`. |
| Save reading warning | Wait for the game to finish writing. The helper retains the last valid snapshot and prevents changes from being applied while the current read is invalid. |
| Unexpected price changes | Open **Review Changes** and **View mapping issues**. Download a backup before applying changes. Ambiguous mappings are never assigned automatically. |
| Data seems missing after moving to localhost | Different page addresses have separate browser storage. Download a complete JSON backup in the old tracker, then use **Backup → Restore** on the localhost page. |
| Russian product names are missing | Select Russian in the tracker. After a game update, the helper retains bundled names and warns if the catalog is outdated. Developers can update the catalog as described in [localization](localization_EN.md). |
| Charts or fonts are missing offline | The original tracker loads these resources from CDNs. Check your internet connection. |

The helper log is at `%LOCALAPPDATA%\SupermarketTrackerSync\logs\helper.log`; rotated logs are stored nearby. Logs may contain local save paths. Review and remove personal information before attaching a log to a public bug report.
