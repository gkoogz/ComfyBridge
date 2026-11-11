# Live results and video regeneration

Beta 62 shares live-result selection between Image and Video. The first recent
thumbnail is an enabled button whenever that generator has queued or running
work. Selecting it marks the thumbnail and displays its job's decoded preview at
full width in Latest result. A spinner is centered over that preview. Before a
preview exists, the panel shows the spinner with a waiting/queued message.

The existing authenticated preview stream feeds the progress thumbnail, PC queue
and selected large result. New decoded frames replace the selected preview
without rebuilding the player panel. A waiting video cannot accidentally show
the currently running image's preview: frames and selection are keyed by job ID.

When generation finishes, its last preview remains visible with the spinner
until the original has downloaded. Images are decoded before replacement;
videos use a decoded poster and the existing completed-file player. If the final
thumbnail is unavailable, a small copy of the live preview becomes the poster so
revoking temporary frame URLs does not erase it. No partial video is played.
Errors and cancelled jobs stop the large spinner and retain their status message.

Selecting another result during a download takes precedence over the late
completion. The completed file can enter the local library without replacing
the media the user has since selected. The selected border also follows a live
job into its completed thumbnail while the original is downloading.

Selected completed videos show **Extend video**, **Regenerate**, and Favorite in
the action row. Regenerate calls the same saved-recipe restore used by the
Library, including the exact seed, first image, final frame, masks and extension
state when applicable. It restores the editor; pressing Generate is a separate
action. Items without a saved generation record cannot be regenerated.

## Verification

`tests/live-results.cjs` covers both generator types: selecting queued/running
thumbnails, full-width preview updates, spinner placement on wide and portrait
images, completion/download handoff, missing final posters, selection races,
terminal errors, cross-kind queues and exact video regeneration.
`tests/queue-preview.cjs` exercises the shared asynchronous preview stream into
the PC queue, toolbar and selected large video preview. Existing media controls,
desktop layout and Library replay browser checks pass as well.

These tests use neutral image fixtures and simulated queues/transfers. They do
not submit a real generation or establish new physical-phone touch behavior.
