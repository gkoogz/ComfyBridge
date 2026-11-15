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

A character reference selects the base H3 Ref2VA checkpoint with a default of
20 steps. It uses the PC's existing H3 text encoder and VAEs. The ordinary H3
and Eros Turbo LoRAs do not apply in this mode. The five source tail frames
guide the start of the new segment and are trimmed before joining the result.
Ref2VA gets the character image as **Picture 1**, separate from the frame
guides. The last-frame guide targets the final frame actually kept.

Place the [ComfyUI FP8 Ref2VA checkpoint](https://huggingface.co/Comfy-Org/MiniMax-H3/blob/main/diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors)
in the PC's `models/diffusion_models` folder. This model file is approximately
21 GB. The APK and Windows ZIP contain the application.

The reference is saved with each generation recipe and displayed in Library
provenance. Regenerate restores the reference alongside the frame inputs.
The [ComfyUI H3 reference workflow](https://github.com/Comfy-Org/docs/blob/main/tutorials/video/minimax/minimax-h3-native.mdx#minimax-h3-reference-to-video-r2v)
describes the model's reference tags and time-based guides.
