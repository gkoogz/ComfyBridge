"""Resize the approved artwork into platform icon containers (Pillow required)."""
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent
image = Image.open(HERE / 'comfybridge.png').convert('RGBA')
image.save(HERE / 'comfybridge.ico', sizes=[(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
for density, size in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
    folder = HERE.parent / 'android' / 'res' / ('mipmap-' + density)
    folder.mkdir(parents=True, exist_ok=True)
    image.resize((size, size), Image.Resampling.LANCZOS).save(folder / 'ic_launcher.png')
