# Beta verification — 0.1.0-beta.1

Validation performed on November 1, 2026, on Windows with the existing ComfyUI-ZLUDA installation and a connected Moto g stylus 2025.

## Observed

- Nine isolated backend integration tests passed: authorization/library isolation, continued batches without a phone, seed increments, idempotent submission, targeted cancellation, archive/unarchive and range downloads, mask conversion/routing, recovery and fixed seeds, input/path validation, and ComfyUI controls returning an empty HTTP 200 body.
- Live ComfyUI validated t2i, i2i, inpainting, and video graphs. Deliberately invalid seeds prevented GPU execution; only the intentional seed errors were reported.
- On the physical phone: real Windscribe public-port connection with TLS pinning, wrong-fingerprint rejection, catalog with 11 models and 83 LoRAs, connection and telemetry display, image/video screens, mask drawing, and settings preset save/restore and separation by generation type.
- A two-item phone batch was accepted by the real ComfyUI queue, then cancelled. The user's existing desktop generation remained running and unrelated work was not interrupted.
- APK signature verification passed v2 and v3. Windows C# compilation, Android Java/dex packaging, JavaScript syntax, and Python integration checks passed.
- The release build uses the same Android signing identity as the installed test build; debugging is disabled.

## Still needs real generation acceptance

No full diffusion image or MiniMax video was rendered through the phone during staging because an existing desktop generation was running. Before considering this stable, complete a neutral prompt render through each of t2i, i2i, masked i2i, and i2v. Observe live sampler previews and progress, disconnect/reconnect during a render, and verify the completed output in the phone library. Play a completed video, seek, save both media types through Android's document picker, and archive/unarchive them.

Also exercise cold PC startup, an owned ComfyUI startup/shutdown cycle, overnight idle behavior, and Windscribe port renewal. No fixed GPU or RAM usage cap is enforced. A preexisting ComfyUI process retains its own memory policy.

## Known boundaries

- Workflow adapters depend on the saved node IDs and model types. Other workflows or significant edits require adapter updates.
- HWiNFO sensor indices and VRAM total are specific to the target PC.
- The Windows monitor is a functional text status window; phone UI is the primary generation interface.
- There is no automatic public IP discovery, port renewal, Wake-on-LAN, multi-user isolation, or remote update service.
- Presets stay on the phone; media stays on the PC unless explicitly saved locally.
- Remote access currently uses a seven-day Windscribe ephemeral rule, not a permanent endpoint.
- Windows executable is unsigned; APK uses the project's private local release signing identity.
