# Consolidated local project

The canonical checkout on this PC is **`E:\ComfyBridge`**, using the existing
`gkoogz/ComfyBridge` repository and its full Git history.

| Location | Contents | In Git? |
| --- | --- | --- |
| Repository root, `android`, `bridge`, `artwork`, `docs`, `tests` | Source, assets, build scripts and documentation | Yes |
| `build` | Generated Windows executable, APK and build dependencies | No |
| `releases` | Convenient links to the current release downloads | No |
| `local/data/app` | Installed Windows application | No |
| `local/data` | Queue, library metadata, settings, notes, chat, pairing credentials, signing keys, thumbnails and model listing cache | No |
| `local/llm` | Local llama.cpp runtime and all existing GGUF models | No |
| `local/archive/session-work` | Earlier prototypes, tools, probes and screenshots | No |
| `local/archive/session-outputs` | Previous release packages, research results and runtime backups | No |
| `local/migration` | Verification manifests, database snapshots and original files retained for rollback | No |

`local` and `releases` are excluded in `.gitignore`. They can contain private
prompts, credentials and large model files; do not force-add them to Git.
Keep a separate backup of `local/data`, especially `signing`, before replacing
the drive or reinstalling Windows. A GitHub clone contains source, not this
private state.

## Start and build

Open ComfyBridge from the Windows Start menu or tray as before. From the repo:

```powershell
.\Start-ComfyBridge.ps1             # Open the panel
.\Start-ComfyBridge.ps1 -Background # Start silently
.\Build.ps1                        # Build into this repo's build folder
```

The launcher intentionally uses the installed application path below so that
existing Windows firewall and startup configuration remain valid. Future
Windows package installations and signing operations follow the same link
and continue writing inside the consolidated folder.

## Compatibility links

The old locations are NTFS directory junctions, not extra installations:

| Existing path | Physical destination |
| --- | --- |
| `%LOCALAPPDATA%\ComfyBridge` | `E:\ComfyBridge\local\data` |
| `E:\ComfyBridge-LLM` | `E:\ComfyBridge\local\llm` |
| Previous session's `work\repo` | `E:\ComfyBridge` |
| Previous session's `outputs` | `E:\ComfyBridge\local\archive\session-outputs` |

Keep these links: saved records, startup entries and earlier tools may still
use their names. Renaming or moving the canonical root requires updating the
links. Do not recursively copy the repo through the old paths when backing it
up; back up the canonical root once.

## External dependencies

**`E:\ComfyUI-Zluda` remains the renderer installation.** Its Python environment,
image/video weights, LoRAs, workflows, uploaded generation inputs and generated
media stay there. The two `comfybridge_*` custom-node folders are integration
files installed into ComfyUI. Moving these assets would break existing source
and output references. The ComfyBridge databases retain those references.

Shared toolchains (Android SDK, Java, Windows/.NET, WebView2 and FFmpeg) remain
installed in their normal system locations. Codex's managed chat attachments
also remain with their chat, outside the application project.

## Migration record

The November 9, 2026 consolidation verified copied files with SHA-256, preserved
the LLM files using a same-volume move, checked SQLite integrity and compared
all table counts. Details and rollback originals are in `local/migration`.
Only one active Git repository remains; retired Git metadata in the private
rollback material is named `.git-retired`.
