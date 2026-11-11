# Video final frame

Beta 61 adds an optional image-only Final frame field below Video's starting
image/video field. It has its own preview, dimensions, aspect ratio and Clear
button. It does not alter the chosen canvas or replace the starting media.
It is available for normal video, final-image-only text/video conditioning, and
video extension. H3 center-crops this ending reference to the selected canvas.

Frontend state stores the decoded input under `inputs.video.finalFrame` with
`data`, `width` and `height`. The generation settings use `finalFrame` for its PC
input filename. Existing recursive profile/settings encoding includes this
nested image in PC backups and multi-device sync; settings presets save it too.
Clearing or changing the starting media retains the independently selected end
image. Clearing the end image removes its path and replay association.

## Conditioning and exact duration

Both supported video models use the installed `MiniMaxH3ImageToVideo` node's
native `last_frame` input. The starting image remains `first_frame` for ordinary
i2v; extension retains its existing five-frame motion guide. Negative-prompt
conditioning receives identical visual references.

H3 rounds internal frame counts to 17k+5. If the selected output is trimmed to an
exact length, an additional `MiniMaxH3AddGuide` anchors the same end image at the
last frame actually kept. A normal 180-frame output uses frame index 179; an
extension adding 180 frames uses index 184 before its five overlap frames are
removed. Native last-frame conditioning also remains on the padded internal
endpoint. This is model conditioning, not appending a still image to the clip.

The bridge advertises protocol 19 and checks that ComfyUI exposes `last_frame`.
An older PC worker produces an explicit update message instead of ignoring the
input. A one-frame output cannot have distinct first and final images.

## Persistence and reproduction

The uploaded end image is copied into the existing content-addressed immutable
recipe store. Queued jobs check it before use. Replay restores the exact ending
input alongside the saved seed, first input, mask and extension data. Editing
the final image invalidates reuse of the old saved graph. Library provenance
lists it separately as Final frame, with source viewing and export supported on
Android and Windows. Optional `finalFrameMedia`/`finalFrameOrigin` references are
kept separate from starting-source relationships.

## Verification

120 backend tests passed, including both model graphs, exact and grid-aligned
lengths, negative conditioning, end-only inputs, extensions, queue submission,
immutable source preservation, replay, tamper detection and provenance.
`tests/final-frame.cjs` verifies the field, unchanged canvas, independent clearing,
presets/backups and submitted settings; desktop and Library restore browser
checks and native desktop tests also passed. Windows and signed Android builds
passed. The running local ComfyUI schema confirmed `last_frame` support.

Fixtures use neutral images/prompts and a simulated renderer. No new GPU video
generation or physical-phone touch test was performed for this feature.
