# Civitai Browse

Beta 75 adds a shared Android/Windows browser backed by `civitai_browser.py`.
Use the gear in the Windows bridge to set a Civitai API key. The key stays on
that PC. The browser identifies the account from Civitai rather than a saved
username; changing keys partitions media, preference history and action receipts
by Civitai account ID. Paired devices share the PC's current Civitai account.

## Discovery

The largest owned, non-archived Image collection is selected first. The dropdown
also offers other owned media collections and reacted media. New collections
are private. Since Beta 90, seven of ten source slots target weighted tag pairs,
one targets a followed creator's public image collection, one targets weighted
creators, and one is LoRA filler. An unavailable collection slot falls back to
tags. Accounts with too few positive tags use available personal sources and
LoRA examples instead. These are source-selection targets, not per-page quotas:
duplicates, bans, nonmatching tag intersections and recent artists are skipped.
LoRA examples cycle through installed, non-archived LoRAs before returning for
the next example, reusing existing preview-cache keys when available.

For You keeps each artist at least ten posts apart across every source. The
last nine artist identities persist per account across pages, refreshes and
bridge restarts. Both creator IDs and normalized names cover older cached LoRA
metadata without IDs. Throttled candidates stay buffered for later; the feed
never relaxes spacing just to fill a page. Startup cache ordering, appends and
offscreen replacements also enforce spacing. Explicit artist/tag feeds and
collection carousels are unaffected.

`chosenBy` is contextual recommendation provenance, separate from generation
resources. LoRA-sourced posts identify the source listing in yellow, even when
that LoRA is absent from the actual generation resources. Public-collection
posts carry the collection ID/name and its owner's ID/name; the UI shows a
via-curator link, following check and a follow control for the actual artist.
This never claims the collection owner personally liked or uploaded the post.

Public collection discovery uses Civitai's website endpoint
[`collection.getInfinite`](https://github.com/civitai/civitai/blob/main/src/server/routers/collection.router.ts)
with `userId`, `types: [Image]`, `privacy: [Public]` and limit 20, then the existing
`image.getInfinite(collectionId)` media route. Returned owner, type and public
visibility are checked again locally. Private bookmarks and someone else's
personal reaction history are not imported. The existing foreground-leased
importer checks at most one followed creator's directory per minute, caches
even empty results for a day, and stops when Browse is inactive. No directory
lookup blocks a feed response. Directory pages also use the shared persistent
API cache and background rate budget; media still has the three-read feed cap.
Unfollowed creators cease to contribute immediately. Collection discovery is
optional: transient failures retain normal browsing and back off. These are
website tRPC interfaces, not a guaranteed stable public developer API.

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


## Beta 79 device cache and timeout

Browse saves an account-bearing snapshot under a key scoped to the paired PC's
fingerprint (host fallback). On launch it paints saved metadata and device blobs
before awaiting account/status. A changed account clears the prior view and
prefetched details. The first 20 items of the selected carousel and the last 10
loaded For you items are retained. Previews are stored in CacheStorage on the
device; the selected 30 are protected from normal 180-file/96 MiB eviction.
Individual files above 8 MiB are not added. Originals/video files are not eagerly
downloaded. With insufficient storage, ordinary online browsing still works.

Carousel paging warms two pages to reach at least 20 when available. Server
cursors are not persisted because the worker can restart; restored carousels
rebuild a cursor and deduplicate before continuing. Refresh retains old visible
content until replacement requests succeed. A blank first-ever visit still
requires a connection; caching cannot supply content never downloaded.

A single bounded detail queue starts ahead of visible items and the retained
30 previews. Up to 100 detail records persist with the snapshot. Viewer reads
reuse those records immediately. Refresh clears detail records, and explicit
social writes invalidate affected records. Collection membership popups always
check fresh state. Background downloads yield to generated-library transfers
and stop advancing while Browse is hidden. Media width/height reserve layout
before image decoding. Near-bottom paging stops automatically after repeated
empty pages or an error, leaving manual retry available.

The stopwatch is a ComfyBridge-only two-hour creator timeout, not an unfollow or
Civitai block. Its expiry and idempotent receipt commit together in the PC's
account-scoped SQLite settings. Every mixed-feed source is filtered, including
cached LoRA samples matched by creator name when no user ID exists. Collection,
reacted and exclusive creator/tag feeds remain accessible. Both phones receive
current timeouts in status; expired entries no longer filter results.

Verification: 152 Python tests and neutral-fixture mobile/desktop browser checks,
including cache restoration with network deliberately held, 20+10 saved image
files, detail request reuse, restarted-cursor recovery, touch pull refresh,
automatic paging, timeout expiry/retry/account isolation. Physical phone touch
behavior is not established by browser emulation.


## Beta 80 session continuity and social state

Feed cursors previously lived only in memory and expired after 30 minutes without
paging. They now persist in account-scoped `feed_sessions` in SQLite, including
upstream cursors, buffered items and seen IDs, and survive worker restarts.
Foreground status supplies the open cursors and elapsed time since real user
input. This renews only those account sessions, based on the last interaction;
background polling alone does not extend their lifetime. Sessions expire after
two hours. A missing cursor rebuilds safely with client seen IDs; older-worker
expiry responses also trigger a single automatic fresh-cursor retry. Existing
media and scroll position remain in place. Repeated empty pages/network failures
remain bounded, with manual retry available.

After two hours without user interaction, the client returns from a creator,
tag or viewer to cached For you and refreshes it. Earlier returns, including returns from another root screen, retain the
current page and scroll. Feed pagination error counters belong to each saved
page rather than leaking between creator and mixed feeds.

Status includes followed creator IDs. Follow/Following appears to the left of
an artist feed title; successful changes update checks in retained feed pages.
The artist name opens an isolated native website view on Android and Windows,
with a top-left Back to ComfyBridge control. It has no Native bridge interface,
API key, resource interception or certificate override. Website sign-in is
separate from the PC API key. Android builds include `ProfileActivity`; Windows
uses a distinct WebView2 data directory. Closing returns to the retained feed.

Prefetched detail data updates the feed's bookmark fill. Collection saves update
all visible/retained representations. Reaction counts render only when positive
and immediately increment/decrement after confirmed writes. The refresh control
rotates a fixed 24-pixel SVG about its 12,12 center instead of a text glyph.

Verification: 155 backend tests pass. Tests cover persisted cursor recovery, 40-minute returns, expiry, account-scoped
renewal, legacy expiry retry, one-hour UI preservation and two-hour UI reset,
follow/profile controls, bookmark fill and zero-to-one reactions. Native Windows
smoke checks verify the website return bar and isolation without visiting a live
profile. No physical Android phone is connected for touch/profile validation.


## Beta 81 full metadata and external browser

The feed's `withMeta` option can still return `meta: null`. Detail prefetch now
calls `image.getGenerationData`, the website Generation data source, for both
prompts, parameters and the complete resource list/strengths. The narrower
`image.getResources` endpoint is only a fallback when generation-data fetching
fails. Account-scoped full metadata survives subsequent lightweight feed/import
writes. Detail format 2 invalidates old incomplete device records without
throwing away cached images. Failed lookups keep existing text, show unavailable
rather than claiming the uploader withheld it, and retry after a bounded cooldown.

Missing avatar URLs are resolved with `user.getCreator` and cached per account
and creator for a day (ten minutes after a failed request). API credentials stay
on the PC; avatar downloads retain the existing trusted CDN restrictions.

The Browse viewer starts with real creator and reaction rows exposed. Scrolling
toward the top stows them and moves X out of view; tapping media reveals X again.
Video controls have a 44-pixel scrollable gutter. Feed opens the creator-only
page with retained back navigation; the adjacent arrow opens their web profile.
Follow/Following is to the right of the artist feed title.

Civitai links normalize to civitai.red at the shared/native launch boundary,
including cached .com links. Windows uses its default browser through ShellExecute;
Android resolves the default HTTPS browser. The former isolated profile WebViews
and their separate login state are removed. OS Back/app switching returns to
ComfyBridge; the external browser does not have a ComfyBridge-owned top bar.


## Beta 82 preference controls and hard bans

Your feed sorts by weight (descending) or name and filters Creators, Tags or
Both through custom dropdowns. These display choices persist per PC/account on
the device. Shared preference state remains on the PC. Five aligned columns are
Tag/Creator, Weight, Vote, Unweight and Ban; voting uses solid SVG carets.

Unweight uses the existing disabled flag but now reports an effective weight of
zero, even when imported history grows. Restoring recovers the current learned
score plus any manual adjustment. A separate banned flag removes all matching
creator/tag media from Browse feeds, including collections, reactions, direct
creator/tag feeds and LoRA filler. This does not unfollow, remove saved media,
or vote on Civitai. Unban clears both banned and disabled and returns the row to
the main list. Overrides retain names and remain listed even after unfollowing
or removal of historical observations. All changes retain account isolation and
idempotent action receipts.

Cached cursor buffers are checked at emission, not only when choosing sources.
Old LoRA/cursor items with unknown tags resolve tags before passing a tag ban;
a failed lookup cannot expose unverified media. The client also filters incoming
pages, retained navigation DOM, open viewers and persistent startup snapshots.
Bans from another device arrive through foreground status. Cached images need
not be deleted to keep them out of the interface. Upstream tag accuracy still
limits semantic filtering: an untagged image cannot be recognized by its pixels.

Regression coverage includes stable zero under new observations, restoring
weights, restart/unfollow persistence, all feed channels, buffered items without
tag metadata, sort/filter/column layout, failed writes, ban/unban, and cached
page pruning on mobile and desktop. These are neutral fixtures, not live social
writes. Physical Android gestures remain a separate unobserved check.


## Beta 83 personal tag weights and intersecting tag feeds

Media details display personal tag weights, descending then alphabetical, rather
than Civitai's public votes. Each caret adds/subtracts five; subtraction clamps
to zero and holds the tag unweighted even as history imports continue. A later
+5 reactivates it at five. Banned tags require Unban in Your feed first. These
controls do not submit public tag votes. The legacy vote route maps +/-1 requests
to +/-5 personal adjustments. Adjustment and retry receipt commit together.
Account-scoped, timestamped weight snapshots refresh cached media across devices
and prevent older metadata replies from undoing a confirmed adjustment.

Mixed-feed tag slots sample two distinct positive tags without replacement;
each draw is proportional to the remaining weights. Zero/disabled/banned tags
are excluded. With fewer than two eligible tags, other available sources fill
the feed; there is no single-tag substitute for a two-tag recommendation.

Civitai's image query accepts a tag array but can implement OR matching. See the
[image schema](https://github.com/civitai/civitai/blob/main/src/server/schema/image.schema.ts)
and [image service](https://github.com/civitai/civitai/blob/main/src/server/services/image.service.ts).
The bridge pages bounded candidate sets, resolves missing tag metadata, then
requires every selected tag before returning a match. Pair buffers use a stable
sorted tag-pair key, are checked again on emission, and cease to be selected when
a member's weight reaches zero. Sparse intersections may need more paging;
there is no relaxation to OR just to fill the screen.

Each delivered item carries chosenBy for its actual feed context. Tag-selected
items highlight the selecting tags in yellow; creator-selected items highlight
the creator. This context is not part of shared per-image metadata, so viewing
the same image from a collection does not inherit a recommendation highlight.

Tapping a tag selects/deselects it in green without navigation. Selections belong
to the current media viewer and survive weight updates. Any selection reveals a
fixed bottom-left Search by tag button. This opens a tags:<sorted IDs>:<media type>
feed that requires all selected tags, including explicitly selected zero-weight
tags (manual search is independent of random recommendations). Back preserves
the prior feed position. The selection clears when changing media; deselecting
all tags removes the button. Image/video/all filters work on tag intersections.

Your feed also has a live, case-insensitive name search above the list. It combines
with the type filter and selected sort across weighted, unweighted and banned
sections. Clearing the search restores the visible list without a network call.

## Beta 84: stable viewer loading

The viewer distinguishes a pending generation-data request from a completed empty response or a failed request. Failures offer Retry details in place and retain any existing prompt. Complete cached details are reused immediately on reopening. Metadata updates leave the hero media element and scroll position intact; opening peek positioning happens once, not on every social-row resize. Scroll anchoring is disabled within the viewer. The full image is decoded before it replaces the visible preview, and the hero is excluded from thumbnail cache URL rewrites.

The viewer-loading browser regression delays metadata and decoding independently, checks unchanged media identity/source/geometry and scroll position, and covers retry, confirmed missing prompts and cached reopen at phone and desktop widths.

## Beta 85: persistent For You exposure and safe cache replacement

`feed_exposure` stores account-scoped post IDs in SQLite. Actually viewed posts
stay excluded indefinitely from For You; recently offered but unviewed posts
are excluded for seven days. Positive imported reactions/collection observations
also exclude those known posts. These rules do not filter explicit collection,
reacted, creator or tag feeds, and make no public Civitai mutations.

The client records a post after 800ms with a meaningful portion of its loaded
preview visible, or immediately on opening it from For You. Hidden documents,
offscreen prefetches and unloaded previews do not count. An account-scoped device
outbox survives offline use and syncs batches to `browse/seen`; the server's
history is shared by both phones. The local lookup retains up to 30,000 IDs;
the durable server history has no viewed-post expiry. Pre-upgrade saved feed
posts are treated as probably seen, and old server sessions seed recent offers.

Mixed-feed delivery is serialized and reserves IDs before responding, including
across concurrent phones and new feed cursors. Source paging progress is reused
for up to 30 minutes; explicit refresh checks source heads again while retaining
all exposure exclusions. Skipped duplicates do not consume the valid-item quota.

Startup omits locally known seen posts from restored For You tiles. Remaining
cached tiles are checked against shared history. A stale tile is replaced only
when its top is more than two viewport heights below the viewport bottom, after
the replacement preview is cached and decoded. The guard is checked again after
download; scrolling close cancels that swap. Visible/nearby tiles are left intact.
Unused fetched replacements join the end of the feed rather than being discarded.
Explicit refresh clears the old For You tiles immediately and requests unseen
results; a failed refresh cannot silently present the stale list as fresh.

Regression coverage includes restart/account isolation, old-session migration,
recent-offer versus permanent-view exclusions, offline outbox persistence,
decoded replacement, viewport stability and cancellation when a tile approaches.

## Beta 86: Browse history swipe

The shared navigation gesture checks Browse history before choosing the drawer. Once horizontal intent is established, an inert overlay holds the actual retained previous screen nodes at their saved scroll position and tracks the finger from the left over the stationary current feed. Commit restores those same nodes through Browse back; a short or cancelled gesture removes the overlay without changing history. Nested creator/tag/preference screens return one level at a time. Vertical scrolling and editable fields retain ownership. Full-screen Civitai media is excluded and keeps its existing gestures. Root For You continues to open the drawer. Search by tag is anchored at bottom right.

The CDP touch regression covers partial progress, commit, cancellation, vertical scrolling, nested history with retained search input, root drawer behavior and full-screen exclusion.

## Beta 87: shared metadata and bounded upstream traffic

The PC owns an account/key-scoped SQLite `api_cache`, shared by both phones and
desktop. Identical concurrent reads coalesce behind keyed locks. Generation
metadata lasts seven days; resource lists and creator profiles one day; following
and collection lists ten minutes; memberships five minutes; named image tags one
hour; source page responses two minutes. Expired responses are not served as
fresh. Cached metadata is private and never packaged. The cache is bounded to
2,000 entries with a 2 MiB per-entry limit. Existing device image caches remain.

Following status is no longer an upstream call for every image. Explicit follow
and collection mutations bypass the relevant read caches for verification and
invalidate affected lists. Retry/idempotency reconciliation remains intact.
Prompt prefetch now requests generation data only, skipping social lookups and
avatar fallback. Only nearby items and a small initial window are queued, with
eight pending items maximum. A viewer uses the prefetched prompt immediately,
then obtains social information separately. The existing 20 carousel/10 feed
preview-file warm cache is retained independently of metadata prefetch.

Normal source pages request 100 candidates; multi-tag pages request 200. Unused
candidates remain in persisted feed buffers. `include: tagIds/profilePictures`
plus named tags avoids per-image tag lookups. Legacy missing tags are repaired
with one `ids` batch (maximum 200), never hundreds of individual calls. Local
all-tag verification remains mandatory because endpoint/index paths differ.
Unknown tags cannot bypass a required tag or ban. Each feed pass permits at most
three upstream page/bulk-repair attempts, including cached attempts. Exhaustion
retains source buffers/cursors; partial results remain usable. Sparse searches
pause with Load more instead of unbounded silent paging. Normal buffered pages
need no upstream source call. Fresh background preference imports use 200-item
pages and run under the background allowance.

`civitai_requests.py` is the shared process-wide governor for Browse and the
model catalogue API helper: 60 actual API starts per rolling minute, at most 20
background starts, minimum 600 ms spacing. Cache hits consume no allowance.
This reserves capacity for foreground use; it is our conservative policy, not
a claimed Civitai service entitlement. CDN previews/files are separate from API
calls and retain their existing download controls. 429 and transient 5xx responses
start exponential cooldowns (5 seconds up to 5 minutes); numeric or HTTP-date
Retry-After can extend them. Cooldown survives worker restart. A capped request
does not create a waiting queue or retry storm. Ordinary 4xx responses are not
automatically retried. The rolling request counts are process-local; cooldown
alone is persisted. Calls from external browsers or other applications are not
covered by this governor.

Research checked 2026-11-16:

- [Image schema](https://github.com/civitai/civitai/blob/main/src/server/schema/image.schema.ts)
  permits 200 results and batch IDs; two read-only live calls confirmed a
  200-image page with tag metadata and a three-ID batch lookup.
- [Public image reference](https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/images.md)
  describes all-of filtering on the new index path and legacy differences.
- [Public rate-limit helper](https://github.com/civitai/civitai/blob/main/src/server/utils/public-api-rate-limit.ts)
  applies 60/120 per minute to particular newer REST families, not a universal
  image quota. Do not interpret other paths as unlimited.
- [Errors guidance](https://github.com/civitai/civitai-developer-docs/blob/main/site/guide/errors.md)
  documents 429/backoff and pagination limits.
- [Terms](https://github.com/civitai/civitai/blob/main/src/static-content/tos.md)
  distinguish expressly provided public APIs from other automated access.
  Browse's existing website tRPC social integration has no public compatibility
  or quota guarantee. Reduced traffic cannot guarantee against enforcement.

Regression evidence: 12 cold prompt prefetches for known feed items perform
12 generation-data calls and zero following/membership calls. Opening those 12
uses one shared following lookup; reopening after a Browser restart uses cached
details without additional metadata calls. Tests also cover concurrent cache
misses, account isolation, fresh mutation verification, sparse multi-tag paging,
bulk tag recovery, budget reservations and persistent Retry-After cooldown.

## Beta 88: optional seven-day field diagnostics

`bridge/api_debug.py` instruments the PC's Civitai metadata API calls, shared
cache lookups, feed passes and detail/prefetch operations. It does not observe
other applications, ComfyUI, local LLM calls or media CDN transfers. Statistics
from all connected clients share one local report. Public builds are **off by
default**; only explicit local activation creates a session:

```powershell
& 'E:\ComfyUI-Zluda\venv\Scripts\python.exe' E:\ComfyBridge\bridge\api_debug.py enable --data E:\ComfyBridge\local\data
# Restart/update the bridge at a safe boundary to load this opt-in session.
& 'E:\ComfyUI-Zluda\venv\Scripts\python.exe' E:\ComfyBridge\bridge\api_debug.py report --data E:\ComfyBridge\local\data
```

`local/data/api-debug-session.json` holds the fixed start/expiry timestamps and a
random session ID. Logs are aggregate SQLite counters under `local/data/api-debug`.
The report command only reads local files and never contacts Civitai. Both paths
are private/ignored and must never be packaged or committed. Running enable again
inside the active week returns the same deadline. After an expired session, only
another explicit enable command creates a new week; installation does not enable
or renew diagnostics. Existing reports remain available on disk.

There is no helper process/thread, scheduled task, timer, polling, or extra API
request. Active instrumentation runs only when the application already performs
work. Each event aggregates into a minute/endpoint/category/outcome/latency-band
row. Storage is capped at 16 MiB per explicitly enabled session. Logging takes a
nonblocking lock and uses a zero-busy-timeout SQLite connection which closes after
each write. Contended samples are dropped and counted. Storage failures disable
the recorder for that worker instead of affecting the request.

Expiry checks use both the persisted wall-clock deadline and a monotonic deadline
for the live worker. Expired startup creates no log/database. An in-flight request
finishing after expiry is not recorded. Once the worker observes expiry, the
disabled fast path performs no diagnostic clock reads or filesystem I/O. No code
wakes up to expire it: while idle it already does no work. Tiny disabled call-site
branches remain in the app; there is no separately running diagnostic resource.

Captured fields: counts, HTTP outcome codes, cache hit/miss/forced refresh,
foreground/background flag, total operation time, time spent waiting before
dispatch, response byte count, returned item count, feed candidate count and
discard count, source reads, and budget pauses. A latency histogram supplements
average/max timings; minute windows show actual upstream attempt volume. The
recorder accepts only allowlisted operation/outcome labels, not URLs, headers,
tokens, account/device/media/tag IDs, prompts, request bodies, response contents,
error strings or images. Data is never uploaded automatically.

Analysis: separate `network` rows (actual upstream attempts) from `cache`,
`budget`, `detail` and `feed` rows. These are overlapping layers, so summing their
latency double-counts work. Network total minus wait approximates upstream time
including response reading/decoding; wait includes the shared network lock and
request pacing. `budget` rows distinguish total cap, background cap and server
cooldown without counting them as upstream calls. Compare cache hit ratios and
feed scanned/filtered/items with the API counts; a low-yield tag intersection is
different from a slow endpoint. The first installation verification may produce
a few samples; do not present those as representative user usage. Reports describe
the configured window and observed samples, not proof that a worker is currently
running or that no samples were dropped. Collect real usage before recommending
further tuning.

## Beta 89: image-backed startup stash and transient failure recovery

The main metadata snapshot was insufficient as a startup guarantee: seen-item
filtering could remove its entire feed, empty refreshes could save an empty list,
and an oversized detail snapshot could fail to persist. Connection changes also
did not wake Browse immediately, leaving it dependent on a 15-second timer.
Observed diagnostics additionally captured upstream HTTP 503 and partial feed
work; those failures were previously wrapped as generic HTTP 400 errors.

Browse now maintains a separate compact `:stash` beside its existing scoped
localStorage snapshot. Only preview paths successfully found/written in device
CacheStorage enter this stash. It retains up to 20 feed entries and 20 collection
entries for each of three recent collection/reaction channels. Detail text and
generation parameters are omitted from this manifest to keep it small. Cached
files referenced by the stash are protected from normal preview eviction.
Incomplete or empty refreshes cannot replace this stash with empty lists. Account
changes isolate it; bans and creator timeouts still remove disallowed entries.

Startup prefers unseen saved feed items, with seen items as a temporary fallback
when otherwise empty. This supersedes Beta 85's rule that startup must always omit
every seen post: availability comes first while obtaining replacements. Existing
safe offscreen replacement remains; explicit refresh retains visible media until
replacement preview data is available. Old complete detail records can recover
metadata when an older build saved empty lists. A prior successfully downloaded
cache is required; a first install or OS-cleared storage cannot display files that
do not exist. No network operation is required to read the stash or cached files.

Cache-only reads bypass pending network requests for the same URL. Reconnection
notifies Browse directly, separately from ComfyUI catalogue readiness. Each loaded
preview can contribute to the stash immediately instead of waiting for the whole
warm-up batch. Warming prioritizes initial collection previews and the saved feed,
then unseen reserve items. If fewer than ten unseen feed items remain, at most one
additional feed pass per minute can replenish the reserve while Browse is open;
existing background/library priority and shared API/request limits still apply.

Civitai 429 and temporary 5xx/network failures use the shared cooldown and a typed
Deferred response. The worker returns 503 plus Retry-After, not a generic 400.
Feed failures retain already found results and cursor state. The client keeps
visible/stashed content, uses a subdued saved-content notice, and schedules
bounded automatic retries while foreground/connected. Authentication and other
nontransient errors remain visible. Refresh failures cannot blank either carousel
or feed. Diagnostics remain enabled only until their existing fixed deadline.

`tests/browse-startup.cjs` exercises real CacheStorage at phone and desktop widths:
all feed posts already seen, no PC network, decoded blob previews, 20 collection
items, reconnect while catalogue loading, quiet legacy/new 503 errors with backoff,
failed refresh, and recovery from the independent stash after deleting the main
snapshot. Existing seen-feed, preferences/ban, cache, navigation and viewer tests
cover the preserved behavior. Backend tests cover 503 classification and partial
feed/cursor preservation. No physical-phone observation is implied by these tests.

## Beta 91: durable recommendation bank and full-media window

For You has one SQLite-backed bank per Civitai account, shared by devices. The
existing selector runs ahead with the same background API governor and three-read
pass budget. The target is 200 eligible metadata records. Delivery takes 12 at a
time without waiting for upstream selection; at 150 remaining or fewer a refill
continues toward 200. Fresh selections are inserted before the older reserve,
behind the protected next 25. Preferences, bans, creator timeouts, seen history,
AND tag matches and one-artist-per-ten spacing are rechecked before delivery.

Each bank entry receives a persisted random expiry 7-14 days ahead. Expiry removes
it from the reserve and the planner's exclusion list, not into viewed history.
Planning itself never records a served/viewed exposure. Taking a page atomically
commits its reservation and optional request receipt; peeking does not consume it.
Startup migration excludes planning sessions from historical served records.

The PC starts a bounded refill and prepares the next 25 thumbnails and full media
at worker startup. Activity renews a ten-minute refill lease; completion leaves no
idle selector timer. Transfers use two workers. Full images retain source pixel
dimensions (the PC fallback may JPEG-encode); videos retain their original file.
The existing 32 MiB image and 256 MiB video download limits still apply. The PC's
2 GiB cache budget is soft: the current prepared window is protected from eviction.

Android begins warming its next 25 on app launch, after library sync/transfers.
It first checks persistent device CacheStorage, then prefers direct HTTPS Civitai
CDN access with a PC fallback if opening the CDN request fails. Only allowlisted
CDN hosts/redirects are accepted; no bridge token or Civitai API key is sent to the
CDN. This avoids relaying each phone download through the PC's upstream connection.
The PC cache remains useful to desktop playback and as fallback; PC and phone can
each fetch a copy, but the phone does not deliberately fetch both routes. Existing
cached media is reused, including video playback and seeking through blob URLs.
Android transfer activity stops while hidden, and library work preempts warming.

The phone protects its upcoming full-media window and existing startup stash;
older unprotected media is evicted at 240 entries or a soft 2 GiB budget. A single
full-media response is capped at 256 MiB. OS cache eviction, initial installation,
large files, or upstream outages can still leave a window partially prepared.
There is no promise that a cold 200-post fill or 25 large videos is instantaneous.

Artist/tag subfeeds warm only their next 12 media, with ordinary page lookahead;
they never create another 200-post bank. The collection/startup thumbnail stash
and metadata detail prefetch remain in place. Older apps may use the compatible
legacy feed endpoint; both sides must be updated for the new bank/window behavior.

Verification: `bridge/test_feed_bank.py` covers persistence, atomic consumption,
account isolation, nonblocking reads during selection, eligibility, fresh ordering,
expiry without viewed marks, and PC warming exactly 25 originals. The neutral
`tests/browse-bank.cjs` checks phone and desktop launch warming, library priority,
25 originals, CDN mapping, cached video seeking without another transfer, and
12-original subfeed warming. Native CDN/fallback code is compiled and inspected;
browser tests do not substitute for physical-phone network verification.

## Beta 92: instant collection choices and hourly discovery

Opening the bookmark picker renders the known collection directory immediately.
It does not force a media-detail refresh or collection-directory lookup. Known
membership is reused; an unknown checkbox state is resolved through a small,
account-scoped membership-only endpoint while the names remain visible. That
lookup does not fetch prompts, creators, following state or directory counts.

The persisted per-account directory has a one-hour refresh/attempt interval,
including explicit refreshes, simultaneous callers and worker restarts. Failed
refreshes retain the previous list for that interval. Initial discovery when no
list has ever been obtained may retry under the shared network governor. Creating
a collection merges the actual returned ID/name directly without discovery.
Confirmed bookmark writes preserve the directory, store membership and adjust
counts when the prior membership was known. Feed hydration preserves this local
membership cache rather than erasing it with a lighter response.

Thirty existing browser-backend tests and six collection-cache regressions pass.
Phone/desktop browser tests cover immediate choices, delayed membership without
checking guessed boxes, cached reopen and creation without status/detail reloads.
No real account mutations are performed by these neutral tests.

Deferred social writes are not enabled in this release. Current upstream Civitai
source exposes `collection.bulkSaveItems` (up to 100 image IDs in one collection)
and individual `reaction.toggle` operations. A future five-minute outbox should
persist desired final state, coalesce repeat changes, bulk collection additions,
pace remaining operations, and reconcile ambiguous toggle results before retrying.
A single HTTP batch is not a promise of a single rate-limit operation.

## Beta 93: durable social write queue

Reactions, collection membership and follows update the shared UI immediately.
The client first persists desired state in localStorage and, on Android, a
synchronous SharedPreferences commit. It hands actions to `browse/social` in
batches of up to 100. The PC commits them to `social_outbox` in browser.sqlite,
with account-scoped receipt IDs and per-client sequence numbers. A lost reply
can safely be retried using the original request ID. Device state is retained
until acknowledged and remotely settled. Changing a choice replaces its pending
intent without extending the original five-minute deadline.

`bridge/social_outbox.py` sends after 60 seconds of upstream API quiet, or gives
work normal foreground quota at five minutes. This is a delivery-attempt target,
not a promise that an unavailable/rate-limited server has accepted the change.
Rate caps and Retry-After remain authoritative. Temporary failures back off and
retain intent. The UI distinguishes saved pending changes from completed sync.
The worker remains awake for normal delivery; persistent failure may sleep after
ten minutes and resumes on app launch. A device disconnected from the PC retains
its own queue until foreground reconnection.

Reactions share fresh status reads (up to 100 image IDs), then toggle only if the
remote state differs. Follows share one fresh following read. This reconciliation
prevents a lost toggle acknowledgement from causing an accidental reversal.
Collection additions use bulkSaveItems, grouped by collection (maximum 100), with
ambiguous/partial counts verified before settling. Collection removals group by
image. A revision check prevents an older completion clearing newer intent.
There is no general upstream bulk mutation for reactions/follows; transport
batching does not exempt individual operations from rate limits.

History imports/public-curation maintenance and bank replenishment beyond the
immediate 25 yield for 60 seconds after foreground API activity. Visible requests
and immediate buffered media retain priority. Known collection directories retain
the one-hour refresh policy. Creation of a new collection stays immediate because
its ID is needed for subsequent membership actions. Local feed weights, bans,
seen history and muting need no upstream write and remain immediate.

Verification: `bridge/test_social_outbox.py` exercises restart/lost-reply recovery,
coalescing, sequence/receipt replay, edits during delivery, account separation,
partial bulk results, grouped writes and offline backoff. `tests/social-queue.cjs`
exercises immediate visual feedback, reload persistence, lost bridge replies and
confirmation on phone/desktop layouts using neutral fixtures. Android compilation
checks the native persistence bridge; browser fixtures are not physical-phone or
actual-power-loss verification. Tests do not mutate the live Civitai account.


## Beta 94: headroom scheduling and ten-minute target

This supersedes Beta 93's quiet-minute rule. Opportunistic social writes,
history imports and reserve-bank refill use the shared governor's available
capacity, not time since the last foreground request. Before each API call,
headroom requires fewer than 36 requests in 60 seconds, fewer than six in ten
seconds, fewer than 12 background requests in 60 seconds, and no server cooldown.
The existing local hard limits (60 total and 20 background calls per minute) and
request spacing remain. These conservative local budgets are not a statement
of Civitai's actual quota. CDN downloads do not count as API requests.

A pending choice becomes normal-priority work after 600 seconds from its initial
queued timestamp; subsequent edits do not reset that clock. This bypasses only
the spare-capacity gate/background quota, never the total cap or cooldown.
Each call checks capacity again so a batch yields if browsing grows busier.
The worker stays awake up to 20 minutes for pending delivery; persistent failures
may then sleep and retry on launch. Device and PC persistence are unchanged.
The client now says ten minutes and shows retry state after that target.

Tests cover light ongoing traffic admitting writes, burst/minute/background
pressure yielding, urgent work respecting server cooldown, and the 599/600-second
boundary with repeated edits preserving the deadline.


## Beta 95: ready-card arrivals and video tossing

Feed pagination now starts 1.5 workspace viewport heights before the sentinel,
using the same threshold in IntersectionObserver and scroll checks; resizing
rebuilds the observer. The batch size remains 12. Pending decoded-image cards
block additional page draws to avoid draining the bank into hidden DOM content.

Feed articles remain display:none until imageBlob plus image.decode succeeds.
Cards reveal in feed order with no pending layout height or exposed controls.
The 180ms entry animates translateY(6px), scale(.995) and a fast opacity fade;
reduced-motion disables it. The borderless 160px Pulling.. sentinel leaves a
noninteractive absolute copy at its old position behind the arriving card,
while the actual sentinel moves to the new bottom. Failed cards remain hidden
and can be retried from the footer. Carousel preview handling is unchanged.

Video hero pointer gestures now share image toss/scroll logic. Pointer starts
inside the bottom 64px of the video element bypass capture for native playback
controls; all other media surface supports tossing. Upward drags still scroll
details; held/directional tosses retain the existing threshold and snapback.
`tests/feed-arrival.cjs` covers decode gating/order, absent pending layout,
spinner cover, responsive prefetch distance, native-control exclusion, mouse
scroll/toss and mobile touch-emulated dismissal. Physical Android remains a
separate verification gate.


## Beta 96: compact social header and persistent creator avatars

Both feed and full-screen media expose one Like action. Its displayed count sums
all four upstream reaction totals (Like, Heart, Laugh, Cry), but filled state is
specifically the user's Like. Taps enqueue only a Like desired-state mutation;
existing other reactions are not silently rewritten. Server schemas and pending
legacy reaction jobs remain compatible. Feed discovery attribution now precedes
the action controls without an inline follow button. Following remains available
on the creator feed. The full-screen creator/provenance group stays left, with
Like and collection on the right, wrapping left on narrow screens.

Creator avatars use a separate `comfybridge-avatars-v1` CacheStorage namespace
bounded to 300 files, plus bounded creator metadata and in-memory object URLs.
Keys include paired-server scope and Civitai account and creator ID; multiple
posts reuse a creator image. Avatar metadata is learned from existing media and
viewer details, without a new per-post profile API call. Creator-feed headings
use that cache before the name, including after app reload and when the next
feed payload omits an avatar URL. Feed warming fetches known avatars after its
media transfers in the existing bounded background lane; visible avatars share
in-flight work. Failed image fetches back off for a minute. Generic media-cache
trimming does not touch avatar files. Initials remain when no valid image is
known. Avatar requests are bridge media/CDN transfers, not new Civitai API reads.

`tests/social-header.cjs` validates aggregate count, Like-only persisted intent,
outline/filled styling, provenance order, wide/narrow action alignment, creator
heading placement, one shared avatar fetch, restart reuse and the 300-file cap.
Existing browse, discovery and durable-social tests use the single Like control.


## Beta 97: follow from full-screen media

A Follow button sits between creator name and Feed in the full-screen social
header only when that creator is not followed. It uses the existing durable
follow action and pending-state overlay; it disappears immediately on a saved
follow and stays hidden on reopen. Creator-feed follow/unfollow controls remain
unchanged. `tests/social-header.cjs` verifies order, queued intent and reopen
behavior at phone and desktop widths.

## Beta 98: schedule rendering around scrolling

Browse records scroll velocity and waits for native `scrollend`, or 48 ms of
quiet at low velocity / 100 ms otherwise, before admitting deferred UI work.
Coalesced tasks run with a 4 ms between-task frame budget. This is not a hard
execution deadline for a single task. Network pagination retains its 1.5-viewport
lead while metadata application, cache scans and snapshot writes wait for rest.
Immediate user actions and durable social-choice writes remain immediate.

Feed metadata builds three cards per scheduled task. Two image workers prepare
cards, and decoding/source assignment and reveal wait for a scrolling opportunity.
Ready cards are revealed in order with grouped DOM writes and geometry reads.
Only cards intersecting the workspace animate; scrolling cancels arrival effects.
The footer spinner pauses offscreen, behind the viewer and when backgrounded.
Unchanged social polling no longer repaints every reaction control.

`tests/scroll-scheduling.cjs` checks both phone and desktop widths: deferred
insertion during movement, prompt insertion after scroll-end, offscreen motion
culling, footer pausing and no repeated reaction rebuilds. Cache/navigation tests
wait for actual card readiness before simulating scrolling. These browser checks
do not measure physical-device frame times; that remains a runtime check.

## Beta 99: Browse top bar and compact sync status

The shared header translates away after 24 px of downward travel beyond the
first 80 px, and returns after 8 px upward or near the top. Direction changes
reset the travel threshold to avoid jitter. It changes no document geometry;
root-page navigation restores normal header behavior. Keyboard focus reveals
the bar. Its central identity area is an accessible scroll-to-top button;
menu, connection, sync and refresh controls remain separate. Reduced-motion
preferences disable the slide transition and smooth scrolling.

The header's sync indicator uses the existing durable local/server outbox,
shows the pending count, then a green check for 1.4 seconds on completion.
Account changes reset completion history. No extra polling or upstream calls
were added. Pending/retry details are in its accessible label and tooltip.
The ring pauses while the bar is hidden, the app is backgrounded or the media
viewer covers it. The previous feed paragraph is no longer created.

`tests/browse-topbar.cjs` covers phone and desktop sizes, scroll direction,
stable geometry, subfeeds, other-page isolation and sync completion.

## Beta 100: docked subfeed controls and download feedback

Creator/tag headings live inside the shared sticky header, as its second row.
They move with the same hide/reveal transform. Before saving a screen or leaving
Browse, the heading is parked back in that screen's section; restoring the screen
docks the same node, retaining handlers and history. Swipe-back preview uses a
clone while preserving the saved heading. Creator-feed captions omit identity,
timeout and attribution controls, retaining Like and Collect. Other feeds retain
their identity controls. Full-screen Follow stays visible as Following with a
green check and remains toggleable, using the same durable social queue.

LoRA preparation accepts Civitai's `fileId` query parameter only as one positive
numeric ID matching the file record. Exact version URLs, supported hosts, model
format, size, scan status and published SHA-256 checks remain required. Rejection
messages distinguish missing hashes from invalid URLs, size and scan problems.
The resource button spins immediately during preparation and start; late status
polls cannot overwrite those local phases. Confirmation still precedes transfer.

Coverage: `browse-topbar.cjs`, `social-header.cjs`, `browse-swipe.cjs`,
`media-tag-weights.cjs`, `browse-download.cjs`, `lora-library.cjs` and
`test_model_downloads.py`. Live Silverdream listing metadata confirmed the
previously rejected fileId URL; actual model download was not used as a test.

## Beta 101: liquid feed loader

`browse-loader.js` owns one controller for the current `browseMore` node. It is
disposed before navigation/history parking and rebound to the restored node.
Canvas waves stay in document flow beneath the last ready card; only the spinner
is positioned relative to the workspace viewport. Upward overscroll at the bottom
tugs the section and waves together, with only 30% of that movement on the spinner.
Horizontal gestures, controls and ordinary vertical scrolling retain ownership.

The approved palette is gold and white with small mint reflections and the app's
mint spinner. Independent staggered droplets swell from the liquid, narrow their
necks and release after 2.8–4.5 seconds, or earlier on rebound. Rebound sparks travel
downward and expire. The wave and droplet subpaths share clockwise winding so their
overlaps cannot subtract transparent holes.

Drawing is capped at 30 fps and DPR 1.5, with bounded particles and no API requests.
Intersection, document visibility, overlays, reduced motion, errors and navigation
gate the animation. A static canvas frame accompanies the existing loading ghost
while a decoded card arrives. The next-page threshold remains 1.5 viewport heights.

Checks: `browse-loader.cjs` (phone/desktop, emulated touch and wheel, separate
anchors, rebound-only particles, pause/disposal); `feed-arrival.cjs`,
`scroll-scheduling.cjs`, `browse.cjs` and `android-assets.cjs`. Browser checks do not
establish physical-phone gesture behavior.

## Beta 102: softer liquid loading edge

Both decorative canvas layers render at 50% opacity, halving the visible opacity
of the waves, droplets and sparkles. The separate green spinner stays fully visible.

## Beta 103: compact media details and collection choices

Browse and model-preview media share inline heading/copy controls, reduced prompt
spacing, compact resource rows (version and strength together) and the same
two-column parameter renderer. Tag text is 14px with minimal outer padding; vote
targets remain 32 by 34px. Follow uses a white unselected state and mint selected
state; chosen-creator labels match its 32px height, padding and corner radius.

Collection creation lives beside the dialog title; the form remains below the
header and repeated taps focus it. Collection rows are at least 50px tall, shaded,
and clickable across their full label. Known collections and the existing durable
social queue are reused without extra directory calls.

Checks: `media-metadata.cjs` at 320/390/1400px, `social-header.cjs`, `browse.cjs`,
`model-gallery.cjs` and `browse-download.cjs`. Phone screenshots are emulated,
not physical-device observations.

## Beta 104: visible feed video playback

`feed-video.js` controls feed cards only. Thumbnail decoding still gates card
admission and layout. Visible clips reuse the existing full-media byte cache,
autoplay muted and loop. Time remaining is event-driven (no polling timer).
The center 64px glass target handles pause/play; the surrounding media button
still opens details. Sound is above Collect; unmuting one clip mutes others.
Carousel thumbnails and full-screen native scrub controls remain separate.

IntersectionObserver pauses clips outside the viewport. Backgrounding, leaving
Browse or opening a viewer/dialog also pauses playback. Offscreen decoder
sources are released after 30 seconds; history retains pause, mute and playback
position. No per-frame JavaScript or extra metadata API calls are introduced.

`tests/feed-video.cjs` uses the neutral four-second teal/sine MP4 fixture in
`tests/fixtures/feed-video.mp4` (FFmpeg lavfi color + sine, H.264/AAC). It exercises
actual playback, looping/countdown, mute, manual pause across scrolling, dialog
and viewer exclusion, outer tap navigation and full-screen scrub preservation
at 390px and 1400px. These are browser checks, not physical-phone observations.

## Beta 105: loader midpoint and stable swipe history

The Fetching... spinner is centered between the resting loader ceiling and the
workspace bottom. Wave spring translation is compensated, keeping spinner motion
independent. Position follows scroll at animation-frame cadence, separate from
30fps canvas drawing. At 150px or less available height it slides below the
viewport; with more room it returns over 140ms. Reduced motion disables this
transition. Section resizing also recalculates the position.

Exhausted creator/tag feeds show a static You have reached the end :) message.
A thumbnail download failure is still retryable rather than mislabeled as an end.

History swipe previews use the same full-width main padding and header gap as
the real Browse workspace. Previously the generic main element's narrower width
and larger padding changed image heights, making saved scroll offsets display
the wrong part of the feed until navigation committed.

Checks: browse-loader.cjs measures midpoint, stow threshold, wave independence
and lifecycle; browse-return-geometry.cjs compares all card positions/sizes before,
during and after a deep-feed swipe at 390/1400px and checks completed-feed text.
Existing touch, scheduling, arrival and video tests cover related behavior.

## Beta 107: shared Library and Browse video player

`video-player.js` / `video-player.css` provide the same center-only play/pause
control and below-picture transport in both viewers (also reused by Latest
Result). The full-width 6px track has a 4px handle extending downward. Elapsed
time follows progress but clamps before the right-aligned total, revealing a
slash at the collision boundary. The transparent range target extends 26px
below the picture; pointer capture isolates seeking from viewer toss gestures.
Keyboard range interaction remains available with a visible focus indicator.

Library retains its complete-file/blob preparation on Android. Browse retains
its media URL/cache transport. The shared component owns metadata, timing and
resize listeners, disposing them when the video is detached. The old native
Browse controls and separate Library transport play button are removed.

Library thumbnails use source aspect ratios in justified rows, preserving DOM
chronology and avoiding square slots. Metadata supplies the initial ratio when
available; decoded thumbnails confirm it. Image/Video headers remove the second
auto margin on the status dot, placing Current Settings at the right.

Checks: shared-video-player.cjs uses the neutral MP4 with proper HTTP Range
responses, measures the flush full-width track and nonoverlapping labels, and
checks real playback/seeking on both viewers at 390/1400px. Related coverage:
media-controls, feed-arrival, feed-video, library-replay, live-results, desktop
and prompt-sizing. Browser checks do not establish physical-phone behavior.


## Beta 108: media handoff into the viewer

FeedVideo.lift transfers the existing video node into the solo viewer and binds
its feed record to a paused clone using the same cached media URL. The clone is
kept decoded during the viewer session; releasing the loan restores normal feed
visibility playback. Image handoff likewise leaves a feed clone. A 210ms FLIP
animation starts at the original element bounds and ends at the viewer bounds;
full-image upgrades wait until it finishes. Reduced-motion skips the flight,
and scrolling or closing cancels it without retaining stale layout transforms.

The image wrapper exposes the actual contained-picture geometry. Video layout
centers the player above the metadata peek, keeping the timeline clear. Side
carets share the close button's visibility states and stow toward their sides;
their center follows the center playback control. Drip layers use 0.8 opacity.

Regression: tests/media-entry.cjs checks original node identity, starting bounds,
real video playback continuity, paused feed clones, toss return and scroll
preservation, caret stowing/alignment, and opacity at phone and desktop widths.
Existing Browse, shared player, feed video, arrival and loading checks also run.
These browser checks do not constitute physical-phone verification.


## Beta 109: collection targets and media tag bans

Collection rows retain native checkbox semantics but the transparent checkbox
covers the entire shaded label, with a separate visible check indicator. The
popup is excluded from global swipe navigation. Keyboard Space/focus and the
existing durable social outbox remain unchanged; unknown membership still waits
for the lookup instead of guessing a checked state.

Media headings gain 9px indentation and use Positive prompt / Negative prompt /
Resources / Tags with algorithm weight. Selected tags expose Ban Tag beside
Search by tag; an entirely banned selection offers Unban tag. Mixed selections
ban all selected tags. Banned chips stay red whether selected or not.

The local tag-ban action validates every selected ID against the stored media,
then writes all weight-overrides and the idempotency receipt in one transaction.
It can introduce previously untracked tags using the stored tag names. This is
the same ban store used by Your Feed, with account isolation and zero algorithm
weight while banned. No upstream tag votes are sent. Unban restores prior weight.
Confirmed bans prune matching feed cards but keep the current sheet open for undo.

Checks: media-metadata (320/390/1400px full-row taps, keyboard and gesture isolation),
media-tag-weights (multi-ban, red persistence, undo, failure), social-queue, Browse,
and the browser backend suite including restart persistence and atomic rejection
of invalid multi-tag requests. Physical-phone verification remains outstanding.


## Beta 110: non-blocking collection membership

Beta 109's row targets were still disabled whenever item membership was unknown.
The membership read could wait behind API traffic, leaving a dimmed, inert row.
Rows now remain enabled and use native indeterminate state until known. A
popup-local choice map preserves explicit add/remove choices over late reads,
even if the social outbox has already acknowledged them. Membership requests
are shared within the popup; failed reads do not prevent local durable choices.
The full-row input remains isolated from drawer gestures. Drip opacity is 1.0.

Checks: Browse delays a membership read while adding then removing, and proves
the eventual checked response cannot undo removal. Media-metadata exercises
whole-row touch/keyboard targets with a failed membership service. Social-queue
and media-entry cover existing durable actions and full-opacity rendering.


## Beta 111: daily collection index and inclusion-first reconciliation

The account-scoped collection_members table stores membership independently of
media cache entries. Migration seeds existing positive collection observations
and known cached memberships; the existing 200-item paginated importer completes
the initial index, then reconciles once per day. The directory's successful and
attempted timestamps also enforce a 24-hour interval, including Browse refreshes.
New collections created here enter the directory immediately.

Each imported page unions additions into the index. Missing entries are counted
only after a complete collection scan; two distinct completed daily misses are
required before removal. Completion receipts prevent a crash/replayed completion
from counting twice. Local deltas after the scan start are protected. Pending
outbox choices overlay the index until acknowledged. Enqueue writes the index
delta and durable action in the same SQLite transaction.

Status includes collectionIndex (media ID to collection IDs) for persistent phone
snapshots. Menus use that cache without a membership request; feed, bank and detail
responses use the server index. Local changes update the device index immediately,
and status reads begun before a local edit cannot overwrite it. The old membership
endpoint remains compatible but reads only local data. Routine detail reads no
longer call collection.getUserCollectionItemsByItem. Ambiguous upstream write
receipts still use targeted verification to avoid falsely reporting a saved action.

Tests: collection-cache covers daily throttling/restarts, multi-page import,
external additions, two-scan removals, partial-scan preservation, replayed completion,
local changes during scans and account isolation. Social-outbox, browser and bank
suites retain write reconciliation and queue guarantees. Browser tests verify cached
membership with no menu lookup plus immediate whole-row toggling.
