# Beta verification

Validation performed on November 1, 2026, on Windows with the existing ComfyUI-ZLUDA installation and a connected Moto g stylus 2025.

## Beta 8 shared queue count

The running video on the paired Moto showed **Queue 1/6 · 76%** with five more jobs queued across image and video. The running job ID matched before and after updating Windows. The worker tests covered extending a running queue from a second phone, retrying the same submission, cancelling a waiting job, advancing after completion and starting a new count after idle. The tray panel test used a single-item batch at shared queue position 2/4.

## Beta 6 Android gallery

- On the paired Moto, the grid touched both viewport edges and its first row began 94 CSS pixels below the app's top edge. The Bridge fit without scrolling both connected and disconnected. Image and video Latest result containers also met both viewport edges.
- A touch drag moved the viewer and the underlying collection together. The original grid DOM and scroll position survived the return. At the Library root, the same gesture opened the drawer.
- A generated image fit the viewer without cropping. A cached short MP4 played and sought in the viewer, with the action bar hiding on play and returning on pause. A larger portrait MP4 played in Latest result and kept its playback position when the shelf refreshed. No Android fullscreen activity or dialog was used.

A separate touch pass used a scrolled grid, partial/cancelled drags, and a range control. A cached portrait clip also played and sought while the bridge was disconnected. Its temporary player handle was released after leaving the viewer.

To repeat the core checks, install a debug build on a paired phone with a cached image and video, forward its WebView DevTools socket to port 9223, and run **node tests/gallery-device.cjs** with Playwright installed. This uses existing media and does not generate, archive or export anything.

## Beta 5 queue, backups and alerts

- The attached Moto submitted two distinct text-to-image jobs while the first was active. Both completed and Android posted separate finished notifications. A short MiniMax image-to-video job also completed: the monitor reported conditioning, sampler steps and frame decoding. The signed APK resumed its in-flight progress notification after updating, then posted the video's finished notification while the app was in the background. All three verification outputs were archived.
- Exercised the fresh-phone restore path with a blank in-memory editing state on the attached phone. Restored settings, inputs, prompt library and presets matched the PC snapshot without uninstalling the app. Isolated tests additionally covered backing up and restoring an image-data reference.
- Fourteen worker tests passed. Two independent client IDs queued jobs. Cross-device cancellation was refused and did not affect the other client's work. Two authenticated clients also exercised actual listener heartbeats and independent disconnect. Only one physical Android device was attached.
- The Windows panel harness verified borderless rounded placement inside the monitor's working area, hide-to-tray, X-to-quit, stage text and batch position. Workflow tests verify interpolation for both saved workflows and that elapsed time alone cannot complete a job.

## Beta 4 local media

- Transferred a real generated H.264 MP4 from the existing PC library over the paired Windscribe address. The Android private file matched the PC SHA-256. After disconnecting the bridge, tapping the video in Library started native Android playback; the media service reported decoded frames.
- The on-device isolated storage test (**tests/Test-MediaShelf.ps1**) checks a 101-item mixed image/video manifest, archive inclusion, complete older-item transfer, rejection of a truncated replacement, changed/deleted/missing-row protection, persistence after reopening the database, explicit removal, and a camera-roll export whose bytes match the protected original.
- Eleven worker integration tests passed, including edit, delete, archive and authentication checks against the media index. The old generation worker can continue rendering during installation.

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

Text-to-image and MiniMax image-to-video ran on the physical phone/PC setup in beta 5. Full i2i and masked i2i renders, end-to-end preview quality, a second physical phone, and repeated seek/export checks across different media sizes remain useful acceptance tests.

Also exercise cold PC startup, an owned ComfyUI startup/shutdown cycle, overnight idle behavior, and Windscribe reconnection to the configured static IP. No fixed GPU or RAM usage cap is enforced. A preexisting ComfyUI process retains its own memory policy.

## Known boundaries

- Workflow adapters depend on the saved node IDs and model types. Other workflows or significant edits require adapter updates.
- HWiNFO sensor indices and VRAM total are specific to the target PC.
- Windows pairing and monitoring use a native panel. Phone presence times out after about 20 seconds without requests.
- There is no automatic public IP discovery, port renewal, Wake-on-LAN, multi-user isolation, or remote update service.
- Private phone originals follow the recent-100 and conflict-review rules in the README. The sync runs while the paired app is open. Camera-roll export is separate.
- Both ephemeral forwarding and the owner's permanent Windscribe static-IP rule were tested from the phone with pinned TLS and a live catalog fetch. Static access requires the PC to remain connected to the purchased static-IP location.
- Windows executable is unsigned; APK uses the project's private local release signing identity.
