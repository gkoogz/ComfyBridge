# Beta verification

Validation performed on November 1, 2026, on Windows with the existing ComfyUI-ZLUDA installation and a connected Moto g stylus 2025.

## Beta 3 connection repair

- The previous tray reproduced Winsock error 10048 when restarting its listeners on the same ports with a child process alive. The new panel test runs 20 restarts with an active client and a surviving child, and makes an authenticated HTTP request after every cycle. A separate listener occupying the TLS port produces an inline error; releasing it lets the next click start both listeners.
- The signed release APK on the Moto connected through the saved Windscribe address. While testing a tray outage, the phone displayed a red dot, “Reconnecting…” and a cancel button. Both tray ports were released while the worker remained alive. After restarting the tray, the same phone showed “PC connected” automatically without a code or another tap (about five seconds in that run).
- Model loading did not hide the successful connection. Live CPU/GPU telemetry and the model loading message were observed together on the phone. No new generation was required for this connection test.

## Beta 2 pairing and panel

- On the physical Android phone over the configured Windscribe static forward: missing address and missing code produced separate inline errors; an incorrect code was rejected; the correct six-digit code paired and loaded the real catalog. A consumed code was rejected, and the saved pairing reconnected without re-entry.
- Windows panel checks exercised the actual form and listeners in an isolated process: code display, remote-address priority, expiry and attempt limit, power off/on, connection refusal while off, close-to-tray, connected status, and a synthetic 1/4 batch at 47%. The panel screenshot uses an example address and an isolated code, not live credentials.
- Ten worker integration tests passed, including a check of the new monitoring route. Monitor reads do not count as phone activity or keep the idle worker alive.

## Beta 1 observations

- Nine isolated backend integration tests passed: authorization/library isolation, continued batches without a phone, seed increments, idempotent submission, targeted cancellation, archive/unarchive and range downloads, mask conversion/routing, recovery and fixed seeds, input/path validation, and ComfyUI controls returning an empty HTTP 200 body.
- Live ComfyUI validated t2i, i2i, inpainting, and video graphs. Deliberately invalid seeds prevented GPU execution; only the intentional seed errors were reported.
- On the physical phone: real Windscribe public-port connection with TLS pinning, wrong-fingerprint rejection, catalog with 11 models and 83 LoRAs, connection and telemetry display, image/video screens, mask drawing, and settings preset save/restore and separation by generation type.
- A two-item phone batch was accepted by the real ComfyUI queue, then cancelled. The user's existing desktop generation remained running and unrelated work was not interrupted.
- APK signature verification passed v2 and v3. Windows C# compilation, Android Java/dex packaging, JavaScript syntax, and Python integration checks passed.
- The release build uses the same Android signing identity as the installed test build; debugging is disabled.

## Still needs real generation acceptance

No full diffusion image or MiniMax video was rendered through the phone during staging because an existing desktop generation was running. Before considering this stable, complete a neutral prompt render through each of t2i, i2i, masked i2i, and i2v. Observe live sampler previews and progress, disconnect/reconnect during a render, and verify the completed output in the phone library. Play a completed video, seek, save both media types through Android's document picker, and archive/unarchive them.

Also exercise cold PC startup, an owned ComfyUI startup/shutdown cycle, overnight idle behavior, and Windscribe reconnection to the configured static IP. No fixed GPU or RAM usage cap is enforced. A preexisting ComfyUI process retains its own memory policy.

## Known boundaries

- Workflow adapters depend on the saved node IDs and model types. Other workflows or significant edits require adapter updates.
- HWiNFO sensor indices and VRAM total are specific to the target PC.
- Windows pairing and monitoring use a native panel. Phone presence times out after about 20 seconds without requests.
- There is no automatic public IP discovery, port renewal, Wake-on-LAN, multi-user isolation, or remote update service.
- Presets stay on the phone; media stays on the PC unless explicitly saved locally.
- Both ephemeral forwarding and the owner's permanent Windscribe static-IP rule were tested from the phone with pinned TLS and a live catalog fetch. Static access requires the PC to remain connected to the purchased static-IP location.
- Windows executable is unsigned; APK uses the project's private local release signing identity.
