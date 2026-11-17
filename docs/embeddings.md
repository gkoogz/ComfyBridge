# Embedding browser and protected prompt tokens

Beta 115 adds an outlined **Embeddings** button beside **Saved Prompts** in both
prompt sections. The browser indexes `models/embeddings` and configured extra
embedding paths, including existing `.safetensors`, `.pt`, and `.bin` files.
SafeTensor headers can identify an encoder family without loading weights;
unknown legacy files remain labelled unconfirmed. Exact file hashes identify
Civitai titles, base models, author descriptions, and previews.

**Search Civitai** explicitly searches textual inversions. Results use cursor
pagination (Civitai rejects numbered pages with query searches), are cached for
an hour per account, and initially show the latest listed version. Search
results remain separate from installed inventory. Downloads require confirmation,
reuse the durable model download queue, verify the published SHA-256, never
overwrite a different file, and place embeddings in the configured embeddings
folder. Downloading does not automatically insert or activate one. New embedding
filenames replace whitespace and prompt delimiters with underscores.

Cards offer **Insert positive** and **Insert negative**. Known mismatched encoder
families are disabled; shared SDXL-family labels still advise following the
author's specific base-model guidance. H3/Eros insertion is disabled because its
text encoder does not implement this SD textual-inversion workflow.

The prompt remains an ordinary string for syncing, saved prompts, recipes, and
generation. `prompt-embeddings.js` renders references as protected inline objects:

```
A ceramic bowl, (embedding:pottery.safetensors:1.0), soft daylight
```

The arrows adjust strength by 0.1. Text remains editable on either side. Backspace,
Delete, cut, and selection replacement preserve the objects; their X removes
them. Rich paste is converted to text. The same editor is attached to fullscreen
prompt editing. Normal textareas remain in use until an embedding is present;
their value and input events remain the integration point for existing controls.
Programmatic replacement through settings, saved text, or Quick edit re-parses
the prompt. Native undo/redo is suppressed inside rich editors so it cannot
silently delete protected tokens.

ComfyUI's existing CLIPTextEncode path consumes these strings directly. No extra
generation node or model load is added by the browser. Syntax reference:
[ComfyUI textual inversions](https://comfyanonymous.github.io/ComfyUI_examples/textual_inversion_embeddings/).

## Shared media viewer

Embedding, LoRA, checkpoint, and video-model samples open the same
`CivitaiBrowser.open` viewer as Browse. They share the X and navigation chrome,
scroll behavior, media toss, prompt copying, resource/social controls, and video
player. Gallery pagination remains lazy. Video samples use cached poster JPEGs
and bounded MP4 downloads. The first three listing thumbnails retain the existing
device cache and library-first scheduling.

The original listing remains behind the fullscreen viewer outside the native
dialog top layer. A rightward metadata gesture raises the actual previous
workspace/listing and slides it over the stationary media page. Short gestures
spring back; committed gestures close the viewer and restore exact scroll state.
Vertical metadata scrolling remains native, and media itself retains tossing.

## Verification

`tests/embeddings.cjs` covers local/remote cards, encoder labels, exact insertion,
strength, deletion protection including an IME fallback, fullscreen persistence,
both prompt targets, and device preview caching. `tests/metadata-back.cjs` and
`tests/model-gallery.cjs` cover cancel/commit and the real prior screen. Existing
Browse, shared-video-player, metadata, LoRA download, model cache, prompt sizing,
and generator tests cover reused behavior. Backend fixtures cover installed
formats, safe header inspection, cached cursor search, embedding download
destinations, checksums, and video previews. These are simulated browser/backend
checks, not a physical-phone gesture or image-generation test.
