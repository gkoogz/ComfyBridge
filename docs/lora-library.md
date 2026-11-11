# LoRA library tools (Beta 67)

## Downloads from preview resources

In a listing preview's **LoRAs used** section, each identified LoRA version has
a green plus beside **Open resource listing**. The app checks the PC's indexed
LoRA files first; an installed version shows a green check immediately after
verification. The check uses the Civitai version or verified SHA identity and
checks that the local indexed file still exists with the expected file stamp.

Pressing plus first prepares a download and shows an inline confirmation with
title, version, base model, approximate file size and destination. No file
transfer starts until **Download to PC** is pressed. Cancel keeps the same image
and browser open. Only the chosen published SafeTensor model file is downloaded;
the bridge requires its SHA-256 and verifies it before making it available.
Unpublished, restricted or unsupported resources report the actual access/file
problem. The existing PC Civitai key is used as a header on Civitai API hosts;
it is stripped on storage-CDN redirects and is never sent to the phone.

The spinner covers queued, downloading and verification states. Progress text
updates without replacing the preview page or its selectable prompt. Once the
verified file is indexed, the control becomes a green check and the new LoRA is
available in the browser/dropdown. Downloading does not silently enable it in a
generation or change LoRA strengths. Catalogue enrichment retrieves the normal
title/preview metadata after the file is installed.

On this PC the destination is `E:\ComfyUI-Zluda\models\loras`, the same directory
as the existing LoRAs. Partial files are isolated under `.comfybridge-downloads`
and never appear as selectable weights. Existing files are not overwritten; a
different file using the same name leads to a version/hash-suffixed filename.
The transfer streams in small buffers without loading model tensors or using
GPU memory. Files are limited to 16 GiB and require 512 MiB free reserve.

Confirmed jobs are stored in `local/data/model-library/catalog.sqlite`. They
continue if a phone leaves or disconnects. Duplicate requests from two phones
share the same job. A reopened worker recovers queued jobs and restarts a partial
download whose previous owner process is gone. Live owners are not stolen.
The worker stays available during downloads while retaining the existing idle
renderer release behavior. Safe worker handoff waits for confirmed downloads.

API routes: `POST lora-download/status` checks up to 64 version IDs without
contacting Civitai; `GET lora-download/prepare/{version}` resolves a file and
returns a 15-minute confirmation; `POST lora-download/start` accepts only that
confirmation, never a caller-supplied file path or download URL. Downloads use
validated Civitai API URLs and HTTPS redirects to supported Civitai/storage
hosts. A published checksum mismatch never exposes a new model file.

## Insert Keywords

**Insert Keywords**, next to **Copy keywords**, appends the published activation
keywords to the positive prompt for the generator from which the browser was
opened. Empty prompts have no leading comma. Trailing commas/whitespace are
collapsed to one comma and space at the boundary; the prompt's internal text and
negative prompt are retained. The change uses normal shared settings persistence.

## Archive

Each LoRA browser card has **Archive** immediately to the right of **Add**. The
browser's top-left **Archive ›** link shows the separate archived list, where
the card action becomes **Unarchive**. **‹ LoRAs** returns to the main list.
Explicit See Listing can still inspect an already-active archived LoRA.

This is a catalogue preference only. Files, active LoRAs, presets and saved
generation recipes remain intact. Preferences are stored on the PC, survive
phone replacement and are shared by both phones. An open browser refreshes
changed catalogue data periodically without repainting an unchanged page.
The unrelated image/video media archive is unaffected.

## Verification

`bridge/test_model_downloads.py` covers preparation without transfer, explicit
and expired confirmation, verified installation, duplicate submits/two-device
requests, a real background thread finishing without a phone, hash failures,
filename collisions, matching unindexed files, deleted/changed files, restart
and dead-owner recovery, live-owner protection, unsupported resources, free
space and size limits, archive persistence/file preservation, URL/path guards
and stripping the Civitai key from redirects. `test_handoff.py` protects active
downloads during worker replacement. The existing backend suite also passes.

`tests/lora-library.cjs` exercises keyword punctuation and both generators,
archive navigation without altering active LoRAs, installed pre-checks,
confirmation/cancel, spinner/check transitions and catalogue availability.
Existing model browser/gallery/device-cache/generator/desktop regressions pass.
Fixtures use neutral images and fake weight bytes in isolated folders. No
real third-party LoRA was downloaded or enabled as a test, and no physical
Android device was attached.

Protocol reference: [Civitai model-version and file metadata](https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/model-versions.md).
