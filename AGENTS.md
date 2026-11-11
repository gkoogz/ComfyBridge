# Working on ComfyBridge

## Start here

- Work in the canonical checkout, `E:\ComfyBridge`. The old Codex session's
  `work\repo` path is a compatibility junction to this checkout.
- Read `README.md` and `docs/local-layout.md`, then inspect `git status`, recent
  commits and the code involved in the request. Preserve unrelated changes.
- This is an Android app and Windows companion for the user's existing ComfyUI
  workflows, not a generic workflow editor. The configured workflows are
  `Image gen.json` and `Video gen.json` under
  `E:\ComfyUI-Zluda\user\default\workflows`.
- Historical reports in `docs` and private archives describe earlier versions.
  Verify current code, installed version, selected LLM and live process state
  before relying on their claims. In particular, early Quick edit experiments
  describe protocols that were later replaced.

## Code map

| Area | Main files |
| --- | --- |
| Shared phone/desktop interface | `android/assets/app.js`, `style.css`, and feature-specific JS/CSS alongside them |
| Android native shell, bridge transport, picker, media cache, notifications | `android/java/com/comfybridge/app/` |
| Windows tray, server, compact panel, desktop WebView | `bridge/Tray.cs`, `Panel.cs`, `Studio.cs`, `Desktop.cs` |
| Pairing and release checks | `bridge/Pairing.cs`, `ReleaseUpdates.cs` and Android counterparts |
| Durable generation queue and ComfyUI transport | `bridge/worker.py`, `workflows.py` |
| Shared settings, notes, history and desktop workspace | `bridge/studio.py` |
| Chat and Quick edit | `bridge/chat.py`, `quick_edit.py`; `android/assets/chat.js`, `chat-format.js`, `quick-edit.js` |
| GPU handoff, pause checkpoints and cancellation | `bridge/gpu_handoff.py`, `comfybridge_checkpoint.py`, `comfybridge_eros_vsa.py`, `cancel_recovery.py`, `handoff.py` |
| Inputs, reproducible recipes and ancestry | `bridge/recipes.py`, `provenance.py`, `extension.py` |
| Live result selection, previews and completed playback | `android/assets/live-image.js`, `app.js`, `gallery.js`, `gallery.css` |
| Model listing catalogue and sample galleries | `bridge/model_library.py`, `model_gallery.py`; `android/assets/model-browser.js` and CSS |
| Build/install | `Build.ps1`, `bridge/Install.ps1`, `bridge/WebView2.ps1` |
| Verification | `bridge/test_*.py`, `tests/`; historical evidence in `docs/BETA-TESTING.md` |

Android and desktop share the web assets. Check both layouts when changing
shared UI or gestures. Keep actual editable text selectable while preventing
accidental selection of navigation controls. Preserve slider interaction,
vertical scrolling and horizontal navigation together.

## Local files and dependencies

- `local/data` contains the installed app (`app`), databases, keys, pairing,
  configuration, source snapshots, thumbnails and cached model listings.
  `%LOCALAPPDATA%\ComfyBridge` is its compatibility junction.
- `local/llm` contains llama.cpp and GGUF files. `E:\ComfyBridge-LLM` links here.
  Selection is in `local/data/chat-runtime.json`; preserve the user's current
  choice. Do not run model setup just to inspect or build the app.
- `local/archive` contains earlier work and output history. `local/migration`
  contains consolidation manifests and rollback originals. These are reference
  material, not active checkouts or places for new development.
- `build` and `releases` contain generated artifacts. All of `local` and
  `releases` is Git-ignored. Never force-add private data, models, prompts,
  screenshots, credentials, signing keys or runtime databases.
- ComfyUI, its Python environment, weights, inputs and generated outputs remain
  at `E:\ComfyUI-Zluda`. Keep those absolute references working. Shared SDKs and
  system tools stay installed outside the repository.
- Keep compatibility junctions intact. Windows startup, executable firewall
  rules, update installers and existing records use the old path names.

## Preserve live work

- The PC is a live workstation. Before deployment or process changes, inspect
  bridge jobs, chat activity and ComfyUI's `/queue`. Do not cancel user work as
  a side effect of testing or updating.
- `local/data/library.sqlite` contains durable jobs, exact settings, saved
  graphs, profiles, library records and provenance. Retain job IDs, receipt
  reconciliation/idempotency, source images/masks, seeds and queue order across
  migrations and restarts. A failed or uncertain submission must be reconciled
  before retrying it.
- Back up SQLite with its backup API or while writers are stopped; copying an
  active database without its WAL is not a consistent backup. Use additive,
  backward-compatible schema changes and preserve existing rows.
- Scope process changes to this installation. Confirm executable, command line,
  PID identity and renderer ownership. Never terminate all Python, ZLUDA or
  ComfyUI processes. Leave unrelated rendering alone.
- Use the existing GPU coordinator for chat and Quick edit. Preserve cooperative
  checkpointing, queue holds and resumption; arbitrary process suspension does
  not release VRAM. Unsupported work finishes before handing off.
- Queued generations must survive disconnected phones and unclean exits. Keep
  multi-phone ownership checks and shared state sync working.
- The Windows X/Alt+F4 hides to tray. Explicit close is in the tray context menu.
  Idle behavior should remain lightweight; do not add continuous heavy polling.
- For an authorized update during active work, retain the worker until its safe
  handoff boundary. Do not replace a running chat backend mid-response. Consult
  the existing installer and handoff code rather than inventing a kill/restart
  shortcut.

## Build and verify

Run from the repository root in PowerShell. Requirements and outputs are in
`README.md`: JDK 17 on PATH, Android platform 35/build-tools 35.0.1, .NET Framework
and the existing ComfyUI Python environment. No Gradle or Electron is used.

```powershell
.\Build.ps1
# Outputs: build\ComfyBridge.exe and build\ComfyBridge.apk
& 'E:\ComfyUI-Zluda\venv\Scripts\python.exe' -m unittest discover -s bridge -p 'test_*.py'

# Pick the relevant UI/integration checks for the change:
.\tests\Test-Desktop.ps1
.\tests\Test-Panel.ps1
node tests/android-assets.cjs
# Set PLAYWRIGHT_MODULE to an available Playwright installation if needed:
node tests/desktop.cjs
node tests/model-browser.cjs
node tests/model-gallery.cjs
node tests/final-frame.cjs
node tests/live-results.cjs
node tests/queue-preview.cjs
```

- Use the relevant existing tests; add meaningful regressions for bugs. A docs
  change does not require rebuilding or running every device test.
- Use isolated fixtures and neutral prompts. Do not submit real user jobs or
  alter live presets, chats, ratings or notes for a test.
- Distinguish source checks, unit/browser tests, signed builds, installed runtime
  checks and physical-phone observations. Never claim an actual render,
  power-loss recovery or device gesture was verified from tests alone.
- Check Windows and Android compatibility when changing API schemas or shared
  assets. Prefer explicit errors for missing inputs and unavailable services.

## Delivery and handoff

- Keep development inside this checkout; put temporary probes and sensitive
  observations under ignored `local`, not new folders around the PC.
- Building, installing, pushing source and publishing a GitHub release are
  separate actions. Perform the actions authorized by the user and report their
  exact status. A source push does not create an APK download release.
- Preserve the existing Android signing key under `local/data/signing`; replacing
  it breaks normal upgrades. Keep generated secrets out of packages and logs.
- When publishing a release, inspect the complete current installer's file list,
  update version references consistently, include APK and Windows ZIP assets,
  and verify uploaded artifact hashes and release visibility.
- Before finishing, report what changed, relevant verification, what is actually
  installed/pushed/published, and any unobserved runtime or device checks. Keep
  durable architectural decisions in these repository docs so the next agent
  does not depend on a private Codex chat or memory store.
