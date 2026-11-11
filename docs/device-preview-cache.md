# Device listing previews (Beta 66)

Checkpoint, LoRA and video-model previews now have a persistent device cache.
Android stores the image blobs and their manifests in app-private IndexedDB
under its stable WebView origin. The Windows studio uses its own stable origin
and WebView profile. This is independent of the PC's existing Civitai cache and
of the generated-media library's newest-100 retention rules. App updates and
normal relaunches retain it. Clearing app data or uninstalling removes it.

## Download order

The catalogue is registered at connection/startup, before visiting a model
browser. Preview transfers wait for the library inventory, recent-media
downloads, manual original-file transfers and settings/profile sync. A new
library transfer aborts an in-flight preview; completed previews remain intact.
Downloads resume when the foreground app's higher-priority work finishes.
Closing/backgrounding or disconnecting the app pauses this lane.
Android also rejects new preview transfers and disconnects the current preview
connection from the Activity lifecycle, independently of JavaScript visibility.

The lane has one image transfer at a time. It cycles across the entire installed
catalogue for preview 1, then 2, then 3. No extra carousel image or full-resolution
preview downloads until every listing's available first three are complete.
Listings with fewer than three available previews use that available number.
Transient failures retry with backoff and keep the first-three barrier in place.
Extras also wait while the PC is still indexing its catalogue.

Merely showing a card does not download a gallery page's twenty images. Gallery
pages contain metadata; reaching the carousel end requests at most three more
image files at a time, behind the first-three barrier. Selected full previews
use the same low-priority queue and retain the local thumbnail until ready.
Gallery metadata and downloaded extras/full previews are cached too.

## Retention and replacement

Each listing receives a random refresh interval of 30–120 days, saved alongside
its cache. Reopening the app does not roll the interval again. Until that age,
changes to the PC/Civitai preview manifest do not replace the existing previews.
An unchanged offered set remains cached indefinitely, even beyond that age.

When the offered set differs and the interval has elapsed, its replacement
previews are downloaded separately. A failed, interrupted or partial replacement
never removes the active set. Once all replacements are decoded and durably
stored, a transaction switches sets and removes retired files only while that
listing is not being viewed. A staged set survives relaunch and can be promoted
without re-downloading. The next refresh interval is independently randomized.

There is no time-based eviction or generated-media quota applied to listing
previews. Storage errors retain existing files and report the failed transfer.
Preview blobs are scoped to the paired PC's certificate fingerprint, so changing
VPN addresses does not flush them or mix different PCs' files. The Civitai API
key stays on the PC; the existing mature-preview setting is preserved.

`model-cache.js` implements this policy. Images are decoded before committing
them. Thumbnail and full-preview responses are capped at 8 and 20 MiB; the PC
normally serves much smaller resized JPEGs. Display URLs point to local blobs,
not the remote PC. Existing pairs can use the new client with the older catalogue
endpoint; Beta 66 also includes the current preview-visibility flag at startup.

## Verification

- `tests/model-preview-cache.cjs`: startup library barrier, preemption and
  resumption, all-model first-three fairness, full-image priority, cache reuse
  after page restart, persistent staggered ages, unchanged display after manifest
  changes, failed staging, staged restart and atomic hidden promotion, decoded
  local blobs, foreground pause/resume, and slow-startup viewport handling.
- `tests/model-browser.cjs`, `model-gallery.cjs`, `media-prefetch.cjs`,
  `lora-controls.cjs` and `desktop.cjs`: existing browsing, gallery, generation
  library priority and generator controls.
- `tests/Test-Desktop.ps1`: native WebView blob decoding and persistent preview
  reuse after its browser process exits and is reopened, with downloads disabled.
- `bridge/test_model_library.py` and `test_model_gallery.py`: existing PC listing,
  gallery and Civitai-key rules.

Fixtures use neutral images and isolated storage. No physical Android device
was attached for this change; Android touch/runtime behavior remains unobserved.
