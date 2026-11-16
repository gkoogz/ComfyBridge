# Civitai Browse

Beta 75 adds a shared Android/Windows browser backed by `civitai_browser.py`.
Use the gear in the Windows bridge to set a Civitai API key. The key stays on
that PC. The browser identifies the account from Civitai rather than a saved
username; changing keys partitions media, preference history and action receipts
by Civitai account ID. Paired devices share the PC's current Civitai account.

## Discovery

The largest owned, non-archived Image collection is selected first. The dropdown
also offers other owned media collections and reacted media. New collections
are private. The feed favors followed creators' latest media and weighted
creators/tags learned from your existing reactions and collections. Local LoRA
samples are filler: normally one in ten source slots when relationship data
exists, and more when personal sources are missing or exhausted. This is a
source-selection target, not a strict per-page quota: duplicates are skipped.
LoRA examples cycle through installed, non-archived LoRAs before returning for
the next example, reusing existing preview-cache keys when available.

Learning is incremental and resumable. Opening Browse renews a 45-second import
lease every 15 seconds while visible. Historical reactions and all accessible
owned media collections are paged into a private SQLite database. Every page
saves its cursor. Closing Browse lets the import stop after its current page;
reopening resumes. Completed scans refresh at most daily. Nothing is reacted
to, followed, voted on or added to Civitai merely by viewing or importing.

Each positive reaction contributes one creator/tag point; collecting contributes
one per collection. Following adds a creator baseline of two. Explicit tag votes
add or subtract one for that tag. Deduplicated source/image observations prevent
rescans or request retries from inflating scores. Undoing an interaction updates
its observation. Completed scans reconcile removed historical interactions.
Existing explicit tag votes are displayed on individual images, but a global
historical tag-vote export is not available; only new in-app votes seed that
extra score. New follows/reactions/collection changes update recommendations.

## Media and actions

The viewer preserves aspect ratio, supports videos, and shows the complete
shared prompt below a one-line hint that disappears on scroll. Creator/profile,
follow, reactions, bookmarks/collections, tags and their votes sit alongside
uniform resource rows. Resource names open their Civitai listing; supported LoRAs
use the existing confirmed downloader and installed checks. Both the new Browse
viewer and existing local model-preview viewer use these controls. Android Back
closes the Browse viewer before acting on the page beneath it.

Every write has an account ID and a unique request receipt. Reactions and follows
are reconciled against current Civitai state before toggling, so an uncertain
response can be retried without toggling a completed change back. Collections
use explicit add/remove lists. The server rejects account changes, invalid IDs,
unsupported actions and collections not owned by the current user. Failures are
shown; they are not reported as successful social interactions.

## Storage, performance and API limits

Private data lives in `local/data/civitai-browser` (outside Git/releases). The
SQLite database holds account preferences, media metadata and request receipts.
The PC media cache is capped at 1 GiB. Thumbnails are resized to 640 pixels;
full images to at most 2048 pixels, with the original listing linked. Individual
video downloads are limited to 256 MiB and fetched fully before playback is
served; images have a 32 MiB source download limit. CDN redirects are allowlisted,
and no API key goes to the CDN. Completed image conversion is atomically committed.
The device thumbnail cache is bounded at 180 entries / 96 MiB where CacheStorage
is available, with an HTTP fallback. Existing LoRA device caches remain separate
and keep their established age/replacement rules. Only near-visible Browse
thumbnails are prefetched; Browse never downloads the entire feed on launch.

REST `/api/v1/me` identifies the key owner. Collections, personalized images,
following, reactions, resources and tag votes use Civitai's first-party tRPC
routes. These are not a stable public REST contract: a Civitai change, key scope,
account restrictions, deleted resources or rate limits can make features
unavailable. The app reports the error and retains local preferences. Network
calls are serialized, paced and honor 429 Retry-After. There is no HTML scraping,
cookie extraction, embedded login or hardcoded user ID. Content availability
follows the existing PC key/account preview configuration.

Relevant upstream sources: [Civitai source](https://github.com/civitai/civitai/tree/main/src/server/routers)
and [developer documentation](https://developer.civitai.com/).

## Verification for Beta 75

- Unit tests cover account/key separation, imports and scoring, retries,
  LoRA underweighting, explicit social commands and media-host validation.
- Browser tests cover phone/desktop layouts, collections, viewer, resource rows,
  escaping, follow/reaction/bookmark/tag controls and Android Back behavior.
- Read-only probes with the configured account verified account, owned
  collections, following, image/resource/tag/membership routes, resumable history
  import, real image downloads and real video thumbnails/full downloads.
- Social writes are exercised against mocks, not by changing the user's real
  Civitai relationships. Physical-phone behavior is not established by these tests.

## Beta 77 feed controls

For You uses full-width media with creator, reactions/counts and a collection
ribbon over the bottom edge. Creator links open a newest-first exclusive feed.
Creator and tag feeds default to All and offer Images/Video filters. Back restores
the retained previous page, loaded items, cursor and scroll position.

The feed summary opens Your feed, sorted by effective weight. Up/down adjusts a
local per-account offset by one, floored at zero. Disable removes that source's
influence while preserving its learned weight and adjustment. Restore re-enables
it. Disabled entries remain below active entries. These preference controls
affect ComfyBridge's recommendations. The media's emoji and collection controls
write the requested interactions to Civitai.

Overrides are stored in the account settings alongside imported observations.
The update and request receipt commit in one SQLite transaction, preventing a
retried weight adjustment from counting twice. Following slots now select among
enabled followed creators using their effective weights. A disabled tag does
not exclude every image carrying that tag; its recommendation weight is removed.

## Beta 78 viewer interaction

Feed reaction buttons have white borders and larger labels/icons. Media detail
reactions share an aligned baseline, and the ribbon opens the collection popup.
Resources sort checkpoints first, with LoRA download/status after the title.
Copy icons sit below positive and negative prompts; tag votes use carets and a
red selected downvote.

The Browse viewer has an overlaid close control and no title strip. Initial
upward scrolling lifts information through the gap below the contained media
before moving the media and details together. Normal vertical drags scroll.
Horizontal drags and downward pulls at the top grab the media. A hold of about
220 ms before moving also grabs it, allowing vertical tosses. Short releases
spring back; a deliberate flick or drag beyond roughly half the shorter viewport
dimension dismisses. The background fades to reveal the retained feed. Videos
keep their native player gestures. Pinch zoom remains browser-owned.
