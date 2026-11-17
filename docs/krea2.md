# Krea 2 Turbo images

Select **Krea 2 Turbo Â· BF16** in Image's model selector or Checkpoint Browser.
The server offers it only when its native ComfyUI nodes, loader type and all
three model files are present. SDXL checkpoints remain available as before.

Run `python setup_krea2.py --root E:\ComfyUI-Zluda` from the installed Windows
package (or `python bridge/setup_krea2.py` from source). The downloader uses the
official Comfy-Org/Krea-2 repository at a pinned revision, resumes transfers,
verifies published SHA-256 values, and never overwrites a different existing
model. Downloads total about 35.4 GB: Turbo BF16, Qwen3-VL-4B BF16 and Qwen Image
VAE. It prefers Hugging Face Xet if installed and otherwise uses resumable HTTP.

The optional HomoFidelis v1 BF16 fine-tune uses the same encoder, VAE and Turbo
settings. Install `HomoFidelis_Krea2_Turbo_BF16_v1.safetensors` in
`models/diffusion_models`, then choose **HomoFidelis Krea 2 Turbo · BF16** in
Image. The two Krea models share the Krea prompt and LoRAs when switching.
[Publisher's files](https://civitai.red/models/2867077?modelVersionId=3239084)

## Independent editors

`state.imageFamilies` holds separate SDXL-family and Krea snapshots, including
prompts, LoRAs/strengths, seeds, canvas, sampler settings, starting images and
masks. Changing the model saves the outgoing editor and restores the other
family without a confirmation. The selected checkpoint within the SDXL family
can still be changed normally. Presets and saved prompt choices are filtered
by family; old saved prompts belong to SDXL. Quick edit drafts also have
family-specific slots. Library recipe restores first preserve the outgoing
image editor.

Banks are persisted in IndexedDB, PC profile backups and the shared image
workspace payload. Older clients that omit banks cannot erase stored banks.
Banks are never included in a queued generation's recipe or model prompt.

## Graph and fixed defaults

The graph follows Comfy-Org's native `image_krea2_turbo_t2i` template:
UNETLoader -> optional LoraLoaderModelOnly -> KSampler -> VAEDecode -> SaveImage.
CLIPLoader uses `type=krea2` and the Qwen3-VL encoder; ConditioningZeroOut supplies
the unused negative branch. The Krea model supplies its native sampling shift.

The UI displays **Turbo Â· 8 steps**, **Euler**, **simple schedule**, and
**guidance off** as fixed settings. Server-side normalization enforces the same
values before storing recipes. ComfyUI's CFG=1 means guidance is disabled; it
is equivalent in purpose to CFG=0 in Krea's separate official inference CLI.
There is no negative-prompt or CLIP-skip control for this workflow. Textual
inversions are not offered for its Qwen encoder; embedded SDXL tokens submitted
to Krea cause an explicit validation error.

Canvas starts at 1024x1024, batch one, with editable seed. Dimensions use
multiples of 16 between 256 and 2048. Image-to-image and masks use the Krea VAE,
with adjustable denoise. Source images remain original files; only the sampling
canvas is scaled. Remacri remains an independent pure upscale operation.

LoRA browsers use catalogue base-model metadata and local SafeTensors metadata
to separate architectures. Unknown LoRAs are not offered for Krea. Known Krea
LoRAs are excluded from SDXL and video browsers; known incompatible embeddings
are omitted. Existing saved SDXL LoRAs are preserved. The server also rejects
cross-family LoRAs before queueing.

## Runtime considerations

The BF16 diffusion weights exceed 20 GB VRAM. ComfyUI must offload portions to
system RAM; the 64 GB workstation should run one image at a time without a
resident LLM/video model. Existing GPU handoff and durable generation queue
remain responsible for serialization. The existing ZLUDA launcher forces FP16
arithmetic for compatibility: the installed source weights are BF16, and no
8-bit or 4-bit quantization is used.

On a Radeon RX 7900 XT with 20 GB VRAM and 64 GB system RAM, the installed
Windows bridge completed one 1024 × 1024, eight-step text-to-image render in
128 seconds of renderer time (132 seconds from queue acceptance to library
save). This included model loading and GPU prompt encoding.

Sources: https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_krea2_turbo_t2i.json
and https://huggingface.co/Comfy-Org/Krea-2/tree/main
