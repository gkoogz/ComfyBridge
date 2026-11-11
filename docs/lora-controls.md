# LoRA controls (Beta 63)

Image and Video share a compact LoRA row. Its slider occupies 60% of the row's
content width, ranges from −2 to 2 in 0.1 steps, and marks −1, 0 and 1. The number
field retains the existing −20 to 20 range and accepts finer precision. A saved
or typed strength outside the slider range stays unchanged when rendering or
reordering; only the thumb is clamped to the end of the track.

The right-hand column contains outlined Remove, Move up and Move down buttons.
Reordering swaps whole entries, retaining strength, enabled state and any
separate recorded CLIP strength. Ordering persists through the existing shared
settings and presets and is used by generation. The mandatory video turbo LoRA
stays first, fixed and non-removable; optional LoRAs cannot cross it.

On touch screens, a vertical swipe over the track or thumb scrolls the page
without editing strength. A sideways drag starting within 24 CSS pixels of the
thumb adjusts it after horizontal intent is established. Tapping elsewhere on
the track does not jump the value. The remaining right-hand space is available
for scrolling. Mouse track clicks/drags and native keyboard/accessibility range
actions remain supported. Slider drags do not open the navigation drawer.

The track's parent handles pointer gestures because Chromium's native touch
range behavior can change a value even when pointerdown is prevented. The real
range remains focusable and accessible. Its pointer surface uses `pan-y` to
preserve native vertical scrolling. Haptics use the existing rate-limited native
slider feedback.

## Verification

- `node tests/lora-controls.cjs`: isolated neutral fixtures verify phone-sized
  and desktop geometry, marks, precise overrides, complete-entry reordering,
  removal, mandatory locks, keyboard and mouse editing. Trusted Chromium touch
  events verify vertical scrolling without changing strength, inert track taps,
  horizontal handle adjustment, haptic dispatch and drawer isolation.
- `node tests/model-browser.cjs`: existing listing selection, duplicate LoRA
  prevention and See Listing behavior.
- `node tests/desktop.cjs`: desktop layout, queue and navigation regression.
- `Build.ps1`: Windows build and signed Android APK verification.
- `tests/Test-Desktop.ps1`: native Windows WebView smoke test.

These are automated browser and native Windows checks. Physical-phone touch
behavior has not been observed for this change.
