"""V1 다크모드 변환 v2: 좌표 기반 마스킹 + 색조 보존 명도 반전.

전략:
  - 원형 프레임 바깥 = 무조건 다크 배경 (외곽 노이즈 제거)
  - 프레임 안쪽:
      유채색(S > SAT) → 그대로 유지 (불꽃·프레임)
      무채색 어두움(S <= SAT, L < 0.5) → 흰색 반전 (모루)
      무채색 밝음(S <= SAT, L >= 0.5) → 다크 배경 (글로우 흡수)
  - 프레임 자체(라이트 안쪽 ~ 다크 바깥 경계의 그라데이션 픽셀)는 유채색이라
    자동으로 untouched 처리됨.
"""

import colorsys
import math
import sys
from pathlib import Path

from PIL import Image

SRC = Path(r"D:\TTLCOINWalet\logo0.png")
DST = Path(r"D:\TTLCOINWalet\logo0_dark.png")

SAT_THRESHOLD = 0.35
LUM_GLOW = 0.50
LUM_VERY_BRIGHT = 0.82
FRAME_OUTER_RATIO = 0.485
DARK_BG = (11, 11, 13)


def main() -> None:
    img = Image.open(SRC).convert("RGBA")
    w, h = img.size
    pixels = img.load()
    cx, cy = w / 2, h / 2
    outer_r2 = (min(w, h) * FRAME_OUTER_RATIO) ** 2

    stats = {
        "outside_frame": 0,
        "glow_to_dark": 0,
        "anvil_inverted": 0,
        "kept_color": 0,
    }

    for y in range(h):
        dy2 = (y - cy) ** 2
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            dist2 = (x - cx) ** 2 + dy2
            if dist2 > outer_r2:
                pixels[x, y] = (*DARK_BG, a)
                stats["outside_frame"] += 1
                continue

            h_, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            if l > LUM_VERY_BRIGHT:
                pixels[x, y] = (*DARK_BG, a)
                stats["glow_to_dark"] += 1
                continue
            if s > SAT_THRESHOLD:
                stats["kept_color"] += 1
                continue

            if l >= LUM_GLOW:
                pixels[x, y] = (*DARK_BG, a)
                stats["glow_to_dark"] += 1
            else:
                l_new = 1.0 - l
                r2, g2, b2 = colorsys.hls_to_rgb(h_, l_new, s)
                pixels[x, y] = (
                    int(r2 * 255),
                    int(g2 * 255),
                    int(b2 * 255),
                    a,
                )
                stats["anvil_inverted"] += 1

    img.save(DST)
    print(f"Saved: {DST}")
    print(f"Size: {w}x{h}")
    print(f"Stats: {stats}")


if __name__ == "__main__":
    sys.exit(main())
