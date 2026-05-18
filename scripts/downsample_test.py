"""원본 로고를 다양한 앱 아이콘 사이즈로 다운샘플링.

목적: 어느 사이즈에서 디테일이 무너지는지 시각화.
산출물: icons/logo0_<size>.png (8개 사이즈)
"""

import sys
from pathlib import Path

from PIL import Image

SRC = Path(r"D:\TTLCOINWalet\logo0.png")
OUT_DIR = Path(r"D:\TTLCOINWalet\icons")
SIZES = [512, 256, 128, 64, 48, 32, 24, 16]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img = Image.open(SRC).convert("RGBA")
    for size in SIZES:
        resized = img.resize((size, size), Image.LANCZOS)
        out = OUT_DIR / f"logo0_{size}.png"
        resized.save(out)
        print(f"  {size:>4}x{size:<4}  ->  {out.name}")


if __name__ == "__main__":
    sys.exit(main())
