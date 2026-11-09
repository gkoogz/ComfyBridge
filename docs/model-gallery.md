# Model preview galleries

The Beta 60 review build adds a larger X in the top-right corner of model listing
popups. A model's sample carousel preserves portrait and landscape aspect ratios.
Reaching its right edge requests the next Civitai page; there is also a More
previews button for keyboard navigation or retrying a failed request. Duplicate
images are merged, empty pages with a continuation cursor are followed, and the
carousel stops at the actual end of Civitai's results.

Tap a sample to open a full-width viewer. Its image fits within the screen
without cropping. The existing thumbnail stays visible while the larger preview
loads. A single-line prompt hint beneath it invites scrolling into generation
details: prompt, negative prompt, uploader, resolution, available parameters and
LoRA/resource references with strengths. Names and original resource listings are
resolved on demand when Civitai supplies version IDs without names. Missing
metadata is labelled as unavailable; the app does not infer an unshared prompt.

The viewer links to the original image and the model's Civitai listing. Each
resolved resource can also link to its own listing. Its X returns to the same
loaded card and carousel position; the listing's X closes the popup. Swipe the
large image or use its side buttons to move between previews. Generation details
scroll vertically below the image.

## Bridge behavior

- `GET /api/model-gallery/{asset}` accepts an optional opaque `cursor` and returns
  twenty image references plus available generation metadata. Requests use
  `withMeta=true`; continuation tokens come from Civitai, not fabricated page
  numbers or caller-supplied remote URLs.
- `GET /api/model-gallery-detail/{asset}/{image}` resolves missing resource names
  through Civitai model-version metadata, with at most three concurrent lookups.
- `/api/model-preview/gallery/{asset}/{image}/thumb` and `/full` download only
  images selected or made visible by browsing. They use the existing authenticated
  Android/Windows image proxy path. Full previews are limited to a 2048-pixel
  longest edge; the original remains available through the Civitai link.
- Metadata is cached in the private model catalogue SQLite database. Image files
  live under `local/data/model-library/gallery`, with a 256 MiB image-cache budget.
  Image and resource metadata tables each retain at most 10,000 entries. Older
  images can be downloaded again rather than imposing a fixed carousel length.
- Model replacement invalidates its cached gallery pages. Temporary failures can
  reuse previously cached metadata, and failed requests can be retried.
- Mature-preview behavior follows the existing saved Civitai-key setting. This
  feature does not change that setting, clear a key, or add a new content filter.
  The key stays on the PC. Only the supported Civitai HTTPS API receives it.

This code is built for review; the installed Windows app and public release
remain Beta 59 until a separate installation/publication is performed.

## Verification

`bridge/test_model_gallery.py` covers cursor pagination, metadata and resource
resolution, lazy image downloads, aspect ratios, cache bounds, offline reuse,
model replacement, URL validation and the existing key-clearing rule.
`tests/model-gallery.cjs` checks the top-right close control, full viewer, prompt
copying, LoRA details, source links, end-triggered loading through empty pages,
deduplication and returning to the original scroll position. Fixtures are neutral
test images and prompts. A real account-authenticated retrieval and a physical
Android touch test have not been performed for this feature.

API references: [Civitai images](https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/images.md)
and [Civitai model versions](https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/model-versions.md).
