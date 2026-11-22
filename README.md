# AION 2 Character Folio

Character Folio is a Windows companion for AION 2 Global. Pick a character from the public armory, inspect the effects on an equipped piece, and see the chance that a Soul Binding reroll will land a useful replacement. The upgrade path ranks opportunities across the entire loadout.

## Using the folio

1. Open `Aion2CharacterFolio.exe` on 64-bit Windows with the Microsoft Edge WebView2 Runtime installed. The application opens in its own window. Players can also build the executable using the instructions below.
2. Enter a character name, choose a Global region, and select the entry on the correct server. The first successful lookup adds that character to the local quick switcher.
3. Select an equipped item and open **Inspect reroll**. Choose an outgoing line, a primary target and any acceptable alternatives. The inspector shows the one-roll probability of the primary target and the combined probability of all selected targets.
4. Open **Upgrade path** to compare equipment or **Build guide** to browse the nine available classes. Use **Refresh gear** after changing equipment. Optional ten-minute refresh starts disabled.

### How the recommendations work

The calculator uses the equipped item's stat and skill pools. Effects already present on the item are excluded from the current draw, including the outgoing effect. Picking a different outgoing line can change the odds on a later roll. Fixed items have an inspection view.

**Consensus** gives equal weight to the published usage percentages from NotMeter Global, NotMeter Korea/Taiwan and Kisk Korea. An unlisted effect contributes zero. Source percentages describe player preferences. The item tables supply roll probabilities. Pick an individual source or save a custom ranking for a particular slot. Model estimates reflect the bundled reference snapshot and can change after game updates.

## Privacy and network use

The first launch opens with an empty roster. A search sends the entered name and region to the official armory. Selecting or refreshing a character requests their public profile and equipment, and portraits and item images may load from game CDNs. Quick switch restores previously fetched gear on the same PC.

The desktop host keeps roster data in IndexedDB and settings in the private WebView2 profile under `%LOCALAPPDATA%\Aion2CharacterFolio\Profile`. **Remove Saved Character** removes a roster entry. GitHub receives no gameplay or roster data from the app. Contributors should use invented examples for bug reports and redact screenshots.

## Building from source

Use Windows x64, Windows PowerShell 5.1 or later, Python 3.9 or later, and the Windows .NET Framework 4.x C# compiler. Run this from the source directory:

```powershell
.\build.ps1
```

The build prepares the bundled class and item tables, downloads WebView2 SDK 1.0.1264.42 from NuGet on the first build, verifies the hashes of its three components, and writes `build\Aion2CharacterFolio.exe`. The runtime is a separate Windows prerequisite. [Microsoft WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

For an offline build, pass `-SdkDirectory` with the extracted SDK. Place the two managed DLLs in `lib\net45\` or in its root and the x64 loader in `runtimes\win-x64\native\`. Use `-Python` to select a Python executable. All generated files stay under `build\`.

## Project map

| Location | Purpose |
| --- | --- |
| `desktop/Desktop.cs` | Windows host, embedded asset handling and allowlisted armory requests |
| `web/ui/` and `web/index.html` | Character search, gear inspector, quick switching and class guides |
| `web/engine/engine.js` | Effect rankings and probability calculations |
| `reference/` | Editable aggregate class statistics and item pool weights |
| `prepare.py` and `build.ps1` | Assemble the reference tables and compile the desktop executable |
| `tests/` | First-run, search, calculation and local-save regression checks using invented inputs |

### Running the interface checks

With Node.js, Chrome and Python available, run:

```powershell
python prepare.py
npm install --no-save --package-lock=false playwright@1.62.1
node tests/first-run.cjs
```

The test intercepts armory requests and creates a temporary browser profile. It checks empty onboarding, a lookup with invented data, reroll recommendations, model switching, all nine classes, persistence across reloads, and recovery after a failed refresh.

## Licensing and sources

The original application code, build scripts, tests and documentation use the [MIT License](LICENSE). The bundled fonts use the [SIL Open Font License](web/ui/fonts/OFL.txt). The separate WebView2 SDK carries its [Microsoft license](licenses/WebView2.txt).

AION 2 is a game by NCSOFT. Character Folio is an independent fan project. Game names and third-party materials belong to their respective owners. The aggregate reference snapshot draws on [NotMeter](https://notmeter.com/?view=setup-guide), [Kisk](https://kisk.app/scoring) and [Aion2.gg](https://aion2.gg/tools/soul-imprint). Source links are preserved with the tables.
