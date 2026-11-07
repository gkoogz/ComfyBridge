# Neutral Quick edit investigation

Date: 2026-11-07. Model: locally installed Qwen3.8-27B-ABLITERATED-Q5_K_M.

The neutral inputs are in tests/fixtures/quick-edit-neutral.json. Tests went through the installed bridge and its existing model/GPU coordinator. No user media prompts were used.

## Observations

- The long workshop edit, negative-list edit, and embedded-command-in-source edit applied their primary requests.
- The concert-hall rewrite added an audience but retained an empty hall. Asking the model to review this contradiction produced an exact copy.
- Explicit correction feedback after an unchanged answer also failed on that case.
- One response added only a comma. Equality checking alone had counted it as a successful edit.
- Replacement-only output without reasoning still failed to resolve the contradiction; changing wording or response shape alone did not demonstrate a solution.
- Quick edit had inherited disabled reasoning: both a zero runtime reasoning budget and enable_thinking=false in the request.
- Enabling a 256-token reasoning budget corrected the same contradiction in two independent requests, taking 94.4 and 95.0 seconds. The other scene details were retained.

## Implementation

Quick edit now enables bounded reasoning, leaving Notepad chat's existing inference mode unchanged. The first request retains the user-specified system wording and edited_prompt schema. Identical outputs and cosmetic-only outputs for content-edit requests trigger one fallback asking for exact substring replacements. The bridge validates unique source matches, nonoverlap, output bounds, and a changed result before proposing it. Invalid replacements never modify the source. Explicit formatting requests remain permitted. Existing GPU coordination and cancellation cover both attempts.

## Limits

These tests demonstrate a neutral failure and an improvement on it, not a universal semantic verifier. A changed response can still contain mistakes. Review before acceptance. Model reasoning adds latency; a fallback can add more. No claim is made that this explains every historical copying failure.

## Final checks

The reasoning-enabled multi-part edit also applied the main requests and removed the empty-hall contradiction, but introduced unnecessary wording (a rainy concert hall and melancholy music). This is not perfect semantic adherence. All 89 backend tests and the Quick edit browser suite passed. The APK signature and assets were verified. No physical-phone test was performed.

## Beta 53 bracketed input

The model-facing user message now contains the original prompt directly in square brackets and the requested edits directly in curly brackets, followed by the user-specified deliverable wording. The input is not a JSON field bundle; output remains edited_prompt JSON. Bounded reasoning and validation remain enabled. The same neutral contradiction case passed in 98.2 seconds, removing the empty-hall contradiction and preserving the scene requirements. Twelve focused tests passed, including literal multiline/bracket preservation. This test does not isolate the template from the reasoning improvement or establish universal reliability.

## Beta 55 review before acceptance

Quick edit now checks each requested change and remaining contradictions before accepting a candidate. A rejected draft is regenerated once from one canonical original prompt plus the specific failed requirements, then reviewed again. The previous substring-replacement fallback is removed. Invalid review output, unresolved failures, unchanged output and cosmetic-only substitutions remain errors. Each edit/review request explicitly sets cache_prompt=false; this excludes prefix-cache reuse between stages without claiming that cache reuse caused historical failures. Notepad chat is unchanged.

Validation: all 91 backend tests passed. A real-model review rejected an injected incomplete neutral candidate, and a separate real-model review accepted a known correct candidate. The initial revision design failed and was not installed. After simplifying revision input, an injected incomplete draft and known failed-review verdict drove the actual local model to produce a blue ceramic bowl on a white wooden table with soft daylight; the subsequent real-model review accepted all requested changes. That repair test took 213 seconds. The first draft and first review in that final test were deliberately injected; the revision and final review were real inference. This tests recovery, not universal semantic correctness. Model review remains fallible and adds latency. No physical-phone test for this server-side change.
