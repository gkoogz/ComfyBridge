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
