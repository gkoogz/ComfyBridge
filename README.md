# ComfyBridge

[Download the Android APK](https://github.com/gkoogz/ComfyBridge/releases/download/v0.1.0-beta.2/ComfyBridge-0.1.0-beta.2.apk) | [Windows package and beta release notes](https://github.com/gkoogz/ComfyBridge/releases/tag/v0.1.0-beta.2)

<img src="artwork/comfybridge.png" width="128" alt="ComfyBridge white cube and play icon on black">

An Android remote for an existing Windows ComfyUI installation. The phone edits generation settings, uploads images and masks, and views results; the PC does the GPU work. A small Windows tray application wakes its Python worker on demand.

**0.1.0-beta.2 is a personal-workflow beta**, adapted specifically to `Image gen.json` and `Video gen.json` in `E:\ComfyUI-Zluda\user\default\workflows`. It is not a general ComfyUI workflow importer. Models, LoRAs, workflow files, prompts, generated media, pairing credentials, and signing keys are not included in this repository or release.

## What is included

- Bridge home screen with connection animation, CPU/GPU telemetry, RAM, dedicated VRAM, and system commit.
- Image generation: text-to-image, image-to-image, and finger-painted inpainting masks; model and LoRA controls; prompts, seeds, batches of 2/4/8/16, progress, previews, and recent results.
- MiniMax H3 image-to-video: required input image, proportional scale controls, frame/FPS duration, fixed model, and mandatory first turbo LoRA.
- Separate image/video settings presets, prompt library, and persistent phone state.
- A phone-only generation library with image/video viewing, native Save dialog, archive, and unarchive.
- Silent Windows sign-in startup, tray monitoring/pairing, authenticated HTTPS with certificate pinning, durable job queue, and worker sleep after inactivity.
- Matching Android launcher, Windows executable/taskbar, and notification-area icons.

## Install the beta

1. Download the APK and Windows ZIP from the beta release. Extract the ZIP to a local folder.
2. Confirm `config.json` points to your ComfyUI installation. This adapter requires the exact saved workflow node layouts, their models/custom nodes, and `venv\Scripts\python.exe` with `aiohttp` and Pillow available. Windows 10/11 with .NET Framework 4.8 is required; Android 8 or later is required.
3. Run `Install.ps1` in PowerShell. It copies the bridge into `%LOCALAPPDATA%\ComfyBridge\app`, registers startup for the current user, and starts the tray icon. For LAN/VPN access, run `AllowNetwork.ps1` once in an administrator PowerShell window. It allows TCP 18764 for this executable only.
4. Install the APK on the phone. Android may require allowing installation from the app used to open it.
5. **On the PC:** click the ComfyBridge cube by the clock (look under the hidden-icons arrow), or open **Start → ComfyBridge**. The panel must say **Server on**. Leave it open.
6. **On the phone:** open **Bridge**, enter the **PC address** exactly as displayed, then enter the **six-digit pairing code** and tap **Pair & connect**. The code works once and expires in five minutes. Click **New code** if needed. After pairing, just tap **Connect to bridge** on future visits.
7. **Away from home:** the PC panel's local address works on its local network. Use **Set remote address…** once to save the HTTPS address *and external port* from your forwarding rule. That address is then the first choice in the panel. Each installation keeps its own addresses private.

![Example PC pairing panel and batch progress](docs/pc-panel.png)

A single click on the tray icon opens the panel. **X** hides it; **Turn server off** closes incoming connections and preserves the off state across restart. Accepted jobs can finish on the PC. The panel shows phone presence and generation progress, including the current batch item. **Quit bridge** is in the right-click menu.

Use the same Windows account for installation and daily use. Installing over an existing version preserves its configuration, credentials, library, and Android state. Close active phone requests before upgrading. A worker already running finishes with its loaded version; it adopts updated Python code after sleeping and waking again. Keep the Android signing key backed up privately if building your own upgrades.

## Windscribe access away from home

Windscribe on both devices does not by itself put them on a shared private network. This beta was tested with both ephemeral forwarding and a **permanent static-IP port forward**. The static rule forwards an assigned public TCP port to the PC bridge on TCP 18764. The phone uses `https://STATIC_IP:ASSIGNED_PORT` and the one-time code displayed by the PC. Select the Windows device in the forwarding rule and connect the PC to that exact static-IP location. The phone can use its own VPN location.

Normal gaming and other traffic continue using your existing Windscribe configuration; ComfyBridge does not install another VPN or change your default route. No domain is required for this pinned-certificate connection.

**Ephemeral forwarding expires after seven days**, and a VPN reconnect/location change may change the address. Renew the rule and update the phone address as needed. For this pairing flow, use a Windscribe static IP with permanent TCP forwarding for a stable unattended address. A static IP is purchased separately from Windscribe. The owner's installation now uses its configured static IP; account credentials and endpoint configuration are not bundled in the beta. See [Windscribe port forwarding](https://windscribe.com/knowledge-base/articles/do-you-support-port-forwarding/) and [static IP options](https://windscribe.com/staticips/).

The PC must be awake, its user signed in, Windscribe connected to the appropriate server, and the tray application running. This release does not wake a sleeping or powered-off PC.

## Workflows and settings

The bridge reads the saved workflow JSON on worker startup. It obtains available checkpoints and LoRAs from the existing ComfyUI API; no model copies are created. Original workflow files remain unchanged.

Image defaults follow the saved sampler and LoRAs, with 1024 × 1536 as the initial app resolution. Without an input image, denoise is locked to 1. Image upload selects i2i; a painted mask selects inpainting. White mask pixels are the region to regenerate. Presets include the input image and mask and are stored on the phone.

The saved video scheduler has an invalid numeric scheduler and a one-step setting. This adapter substitutes `simple`, four steps, and denoise 1 for the saved turbo LoRA. The video model and first LoRA identity are fixed. H3 frame counts round up to `17k + 5`; duration is **actual frames / FPS**. Resolution rounds to a 32-pixel grid, so source aspect ratio is approximate. Red indicators mark over 768 × 1152 pixels or over 300 requested frames; these are warnings, not hard limits.

Batch seeds increment when the batch is accepted; disabling increment repeats the chosen seed. Cancelling does not rewind reserved seeds. Stop targets phone jobs only, including queued items in that batch, using the ComfyUI prompt-specific interruption API. Use a current ComfyUI version supporting targeted interruption; the adapter was validated against the installed version.

## Idle behavior and storage

The tray listener stays available. After roughly 90 seconds without phone requests and with no unfinished jobs, the Python worker exits. The tray releases telemetry handles and trims its working set. A sample from beta 1 on the target PC measured about **0.54 MiB resident** for the idle tray, with about **28 MiB private committed memory**; these are different measurements and will vary. This is a small service, not literally zero RAM.

Disconnecting the phone does not cancel accepted work. The worker finishes queued jobs. If ComfyBridge launched ComfyUI itself, it shuts down that owned process tree once idle and the ComfyUI queue is empty. A preexisting desktop ComfyUI process is reused and left running. Quitting the bridge removes remote access while its worker finishes queued jobs. Windows reboot or process failure can interrupt an active GPU render; durable records reconcile against ComfyUI history when the worker next wakes.

| Location | Contents |
| --- | --- |
| `%LOCALAPPDATA%\ComfyBridge\app` | Installed executable, Python adapter, configuration |
| `%LOCALAPPDATA%\ComfyBridge` | Pairing key, TLS certificate, logs, SQLite job/media records, thumbnails |
| `%LOCALAPPDATA%\ComfyBridge\signing` | Local APK signing key and password; never upload |
| `COMFY_ROOT\input\ComfyBridge` | Phone uploads and masks |
| `COMFY_ROOT\output\ComfyBridge` | Phone-generated images and videos |
| Android application storage | Connection settings, prompts, presets, input images, current state |

Archive changes library visibility; it does not move or delete the original file. Clearing Android app data deletes phone presets and pairing settings. `Uninstall.ps1` removes current-user startup and the firewall rule (administrator rights required for firewall removal); it retains the library, credentials, uploads, and generated files.

## Security and telemetry

The phone authenticates the PC using the six-digit code. Enrollment uses SRP-6a with the [RFC 5054](https://www.rfc-editor.org/rfc/rfc5054#appendix-A) 2048-bit group, SHA-256 and a proof bound to the TLS leaf certificate. The code never travels over the network. On success, the app privately stores a strong bearer credential and certificate pin for future connections. A code is single-use, expires after five minutes, and permits at most five enrollment starts. Closing the panel or switching off the server invalidates it. Previously paired HTTPS phones keep their pairing. No manual key or fingerprint is required.

Direct pairing requires HTTPS on the PC's TLS port (18764, or its forwarded external port). HTTP ports 18765 and 18766 are loopback-only; never forward them to the Internet. An HTTPS proxy that terminates TLS with a different certificate cannot enroll via this code protocol. Keep the PC's stored secrets private. This personal beta has not received an independent security audit.

CPU and memory come from Windows counters/APIs. GPU load and CPU/GPU wattage use the same HWiNFO registry export available to the target PC's Rainmeter setup; values show unavailable if absent. The beta's HWiNFO sensor indices and 20 GiB VRAM capacity are specific to the target RX 7900 XT PC. The memory tile reports system **commit**, not measured pagefile occupancy or shared GPU memory.

## Build and verify

Install Java JDK 17 on PATH, Android SDK platform 35 and build-tools 35.0.1 under `%LOCALAPPDATA%\Android\Sdk`, and .NET Framework 4.8. No Gradle, Electron, or Python bundler is required.

```powershell
.\Build.ps1
# Outputs: build\ComfyBridge.apk and build\ComfyBridge.exe
# Optional development build with WebView inspection:
.\Build.ps1 -DebugBuild
.\tests\Test-Panel.ps1

# Run integration tests using the configured ComfyUI Python/workflow files:
E:\ComfyUI-Zluda\venv\Scripts\python.exe .\bridge\test_bridge.py
```

The build creates a local APK signing key on first use. Release builds disable Android debugging. Windows binaries are not Authenticode signed. The installer must be packaged alongside `worker.py`, `workflows.py`, `config.json`, `Install.ps1`, `AllowNetwork.ps1`, and `Uninstall.ps1`. Icon source and its resizing utility are in `artwork/`.

See [beta verification and remaining device tests](docs/BETA-TESTING.md). APK signing and automated tests do not establish that every GPU workflow has rendered successfully on a device.
