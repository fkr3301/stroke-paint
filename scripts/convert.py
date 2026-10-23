#!/usr/bin/env python3
"""Convert any Pillow-readable image (webp/heic/tiff/bmp/gif/avif/...) into a PNG
that stroke-paint's built-in decoders can read.

    python scripts/convert.py input.webp output.png

Needs Pillow. If you don't have it, the bundled DSH Python already ships with it.
"""
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is not installed for this Python; use a Python that has it (DSH bundles one).")


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit("usage: python convert.py <input> <output.png>")
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    if not src.exists():
        sys.exit(f"no such file: {src}")

    with Image.open(src) as im:
        im.seek(0)  # first frame of animated gif/webp
        has_alpha = im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info
        out = im.convert("RGBA" if has_alpha else "RGB")
        out.save(dst, "PNG", optimize=True)

    print(f"{src} -> {dst}  ({Image.open(dst).size[0]}x{Image.open(dst).size[1]})")


if __name__ == "__main__":
    main()
