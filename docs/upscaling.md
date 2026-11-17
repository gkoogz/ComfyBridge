# Remacri image upscaling

Beta 116 adds **Upscale** to image actions in Library and Latest Result. It loads
the original, full-size image into Image's Starting Image field and opens that
panel. It does not submit work until **Upscale 4x (Remacri)** is pressed.

Starting Image has Apply Mask and Upscale 4x on the left, Clear on the right.
Resolution, aspect ratio and the high-resolution hint share a compact,
left-aligned row below (Beta 117). The mask and normal generation settings are preserved;
upscaling processes the entire source without applying a mask.

## Installation

Run `bridge/Setup-Remacri.ps1` in a source checkout, or `Setup-Remacri.ps1` in a
Windows release. `-ComfyRoot` can override the default `E:\ComfyUI-Zluda`.
The installer downloads FoolhardyVEVO's original 4x Remacri linked by
[OpenModelDB](https://openmodeldb.info/models/4x-Remacri), pins the Hugging Face
revision, verifies SHA-256 and only then moves it into `models/upscale_models`.
Existing files with a different hash are never overwritten. The approximately
67 MB model is not bundled with the app or public source.

SHA-256: `e1a73bd89c2da1ae494774746398689048b5a892bd9653e146713f9df8bca86a`

## Queue and workflow

An upscale remains an image job with `settings.operation = remacri4x`. It uses
the existing durable request ID, immutable input preservation, serialized GPU
queue, cancellation, crash recovery and Library output collection. Its saved
graph is LoadImage -> ImageUpscaleWithModel (UpscaleModelLoader) -> SaveImage.
There is no checkpoint, CLIP, LoRA, diffusion sampler, VAE or mask in this graph.
The installed ComfyUI standard upscaler tiles internally with overlapping tiles
and retries smaller tiles on GPU out-of-memory errors.

The server derives dimensions from the preserved source bytes. 1024 x 1536
becomes 4096 x 6144. Outputs are limited to 40 megapixels and 16384 per side to
stay within the app's existing image input budget. A second upscale of an
already-large image is rejected before queue admission. Original source and
existing outputs are retained, and results record their source ancestry.
Restoring an upscale loads its original source and directs the user to the
dedicated upscale button, without replacing the editor's selected checkpoint
with an upscaler filename.

## Verification

`bridge/test_upscale.py` checks source-derived dimensions, pure upscale graphs,
missing models, source containment and size limits. `tests/upscale.cjs` checks
320/390/1440-width layout, image handoff, pending disabled actions, one-job
submission, unchanged editor settings/mask and automatic result selection.
Existing result-action, generator and provenance tests also cover shared paths.
Browser tests do not establish physical-phone touch behavior.

A neutral 1024 x 1536 test on the installed RX 7900 XT/ZLUDA runtime produced
a 4096 x 6144 PNG in 40.4 seconds including first-run compilation. It used
an isolated diagnostic output directory and did not add or alter Library jobs.
