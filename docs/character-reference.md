# Stable Character reference

On Video, **First / last frame** contains two independent pickers. The First frame
picker also accepts a source video. The two Clear buttons affect their own
inputs. **Stable Character reference** below it accepts an image for identity.

Choose a clear image of the character, then generate or extend a clip. **Extend
video** on the result loads the original character image from that clip's
recipe. Subsequent extensions use the same saved file, including after an app
restart or on another paired device. Clear or replace the reference to change
that branch's next generation. The Last frame remains a separate optional pose
or composition target.

With a character reference attached, the Video model controls offer Eros Max
Beta 7 and stock H3 Ref2VA. Attaching or inheriting an image keeps Eros selected
when it is already active and keeps its sampling settings. Its reference path
uses the built-in Turbo and the same Eros sampler, shift and attention settings
as an ordinary Eros generation. Stock H3 Ref2VA defaults to 20 steps and uses
its base weights. Both use the PC's existing H3 text encoder and VAEs. The five
source tail frames guide the opening and are trimmed before joining the result.
Ref2VA gets the character image as **Picture 1**, separate from the frame
guides. The last-frame guide targets the final frame actually kept.

Place the [ComfyUI FP8 Ref2VA checkpoint](https://huggingface.co/Comfy-Org/MiniMax-H3/blob/main/diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors)
in the PC's `models/diffusion_models` folder to use the stock option. This file
is approximately 21 GB. Eros uses its own checkpoint for reference generation.

The reference is saved with each generation recipe and displayed in Library
provenance. Regenerate restores the reference alongside the frame inputs.
The [ComfyUI H3 reference workflow](https://github.com/Comfy-Org/docs/blob/main/tutorials/video/minimax/minimax-h3-native.mdx#minimax-h3-reference-to-video-r2v)
describes the model's reference tags and time-based guides.
