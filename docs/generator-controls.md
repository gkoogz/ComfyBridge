# Generator controls (Beta 113)

Image and Video LoRA rows show a plain name with enable, listing and remove controls. The remove button and numeric strength share their right edge; a 36px empty gutter plus spacing remains available for vertical scrolling. Slider touch arbitration and mandatory video LoRA locks are retained. Reordering and per-row model dropdowns are removed; Add opens the existing LoRA browser.

Saved Prompts sits before Quick edit in each prompt action row. Its popup lists the shared saved strings and offers Insert/Delete and a new text field with Save Prompt. Insert appends with a comma-space separator, respecting an existing trailing comma, colon or semicolon. Existing saved names/text are preserved; new entries derive a short label from their first line. Both positive and negative fields use the shared list and existing settings sync.

The catalogue supplies sampler names from ComfyUI object_info: KSampler for images, KSamplerSelect for videos. Submitted choices are validated against those lists and wired into the graph. Image Clip skip uses a positive number (1-24), mapped to CLIPSetLastLayer's negative layer number. H3 does not use that CLIP node, so it has no clip-skip control. Missing settings retain original workflow defaults. Recorded replay is invalidated when either value changes, ensuring edits actually apply.

Generate selects the first newly accepted job, expands Latest result, and shows its queued/live preview. Width and height accompany job status and reserve the full preview and thumbnail's aspect ratio before frames arrive. A selected queued job remains selected even if an older job is currently rendering. Existing selection/download race protection remains intact.

Verification: generator-settings.cjs covers prompt operations, sampler payloads and automatic portrait/landscape selection; lora-controls.cjs covers mobile touch scrolling, numeric override, button alignment, gutter, mandatory locks and desktop layout; test_sampling_settings.py verifies graph wiring and replay invalidation. Existing live-results, quick-edit, lora-library, prompt-sizing and final-frame suites pass. No live generation or physical-phone interaction was performed as a test.

Latest result uses one shared, right-aligned action strip for live and finished items. Make video/Extend/Regenerate and Favorite use matching 40px rounded controls. Queued/running items render the same disabled strip, preserving height until the finished media is ready. Image loading no longer inserts a separate Make video button outside that strip.

Disconnect is red while connected. Sidebar queue lists are capped at four 52px expanded rows (176px for four compact collapsed rows) and scroll internally, with the navigation remaining anchored below the sidebar content.

## Beta 114: complete Latest Result actions

Latest Result reuses Library input/export/archive/reveal behavior. Images show Make video, i2i, Regenerate, Save, Archive and Favorite; videos show Extend, Regenerate, Save, Archive and Favorite. Windows also offers Open file location and uses Save a copy. Save, Archive and Reveal use compact icons with accessible names/tooltips. The action strip has no right padding, remains on one line, and starts at its right edge when it overflows a narrow screen; horizontal swiping reveals remaining controls. All actions are disabled during queued/running generation and retain the same row height when the original becomes ready.

result-actions.cjs verifies flush alignment and one-line layout at 320/390/1440px plus image/video export/regeneration, image input reuse, video extension and desktop reveal. live-results.cjs verifies matching disabled/enabled action counts and row heights across completion. Library provenance checks pass with the shared export/archive implementations. Physical-phone interaction remains unverified.
