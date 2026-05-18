"""벼린 브랜드 — 전 플랫폼 앱 아이콘 자산 일괄 생성.

원본: D:\\TTLCOINWalet\\logo0.png (2048x2048)

산출물 트리:
  D:\\TTLCOINWalet\\icons\\dist\\
    ios\\AppIcon.appiconset\\        — Xcode 드래그앤드롭용 (Contents.json 포함)
    android\\mipmap-{m,h,xh,xxh,xxxh}dpi\\  — Android 라우처
    android\\adaptive\\               — Oreo+ Adaptive Icon (fg/bg)
    web\\                            — favicon, apple-touch, PWA manifest
    windows\\                        — Microsoft Tiles + browserconfig.xml
    macos\\icon.iconset\\             — iconutil 입력 폴더
    social\\                         — og-image, twitter-card

브랜드 컬러:
  잉걸 오렌지 #E84D1A — Adaptive bg, PWA maskable bg, OG image bg
  밤 모루   #0B0B0D — 다크 OG
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw

SRC = Path(r"D:\TTLCOINWalet\logo0.png")
ROOT = Path(r"D:\TTLCOINWalet\icons\dist")

EMBER_ORANGE = (232, 77, 26)
NIGHT_ANVIL = (11, 11, 13)
PAPER_WHITE = (250, 250, 247)


def clean_dist() -> None:
    if ROOT.exists():
        shutil.rmtree(ROOT)
    ROOT.mkdir(parents=True)


def resize(img: Image.Image, size: int) -> Image.Image:
    return img.resize((size, size), Image.LANCZOS)


def save_square(img: Image.Image, out: Path, size: int) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    resize(img, size).save(out, optimize=True)


def composite_on_color(
    fg: Image.Image, size: int, bg_color: tuple[int, int, int]
) -> Image.Image:
    bg = Image.new("RGBA", (size, size), (*bg_color, 255))
    bg.alpha_composite(resize(fg, size))
    return bg.convert("RGB")


def padded_on_color(
    fg: Image.Image,
    canvas_size: int,
    content_ratio: float,
    bg_color: tuple[int, int, int],
) -> Image.Image:
    bg = Image.new("RGBA", (canvas_size, canvas_size), (*bg_color, 255))
    content = int(canvas_size * content_ratio)
    resized = resize(fg, content)
    off = (canvas_size - content) // 2
    bg.alpha_composite(resized, (off, off))
    return bg.convert("RGB")


def generate_ios(src: Image.Image) -> None:
    out = ROOT / "ios" / "AppIcon.appiconset"
    out.mkdir(parents=True, exist_ok=True)

    entries = [
        ("20", "1x", 20, "ipad"),
        ("20", "2x", 40, "ipad"),
        ("20", "2x", 40, "iphone"),
        ("20", "3x", 60, "iphone"),
        ("29", "1x", 29, "ipad"),
        ("29", "2x", 58, "ipad"),
        ("29", "2x", 58, "iphone"),
        ("29", "3x", 87, "iphone"),
        ("40", "1x", 40, "ipad"),
        ("40", "2x", 80, "ipad"),
        ("40", "2x", 80, "iphone"),
        ("40", "3x", 120, "iphone"),
        ("60", "2x", 120, "iphone"),
        ("60", "3x", 180, "iphone"),
        ("76", "1x", 76, "ipad"),
        ("76", "2x", 152, "ipad"),
        ("83.5", "2x", 167, "ipad"),
        ("1024", "1x", 1024, "ios-marketing"),
    ]

    images = []
    seen_pixels: set[tuple[int, str]] = set()
    for pt, scale, px, idiom in entries:
        key = (px, idiom)
        filename = f"icon_{px}_{idiom}.png"
        if key not in seen_pixels:
            composite_on_color(src, px, PAPER_WHITE).save(out / filename)
            seen_pixels.add(key)
        images.append(
            {
                "size": f"{pt}x{pt}",
                "idiom": idiom,
                "filename": filename,
                "scale": scale,
            }
        )

    contents = {
        "images": images,
        "info": {"version": 1, "author": "byeorin"},
    }
    (out / "Contents.json").write_text(
        json.dumps(contents, indent=2), encoding="utf-8"
    )


def generate_android(src: Image.Image) -> None:
    dpis = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for dpi, size in dpis.items():
        out = ROOT / "android" / f"mipmap-{dpi}" / "ic_launcher.png"
        save_square(src, out, size)
        round_out = ROOT / "android" / f"mipmap-{dpi}" / "ic_launcher_round.png"
        save_square(src, round_out, size)

    adaptive = ROOT / "android" / "adaptive"
    adaptive.mkdir(parents=True, exist_ok=True)
    fg = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
    content = resize(src, 264)
    fg.alpha_composite(content, ((432 - 264) // 2, (432 - 264) // 2))
    fg.save(adaptive / "ic_launcher_foreground.png")
    Image.new("RGB", (432, 432), NIGHT_ANVIL).save(
        adaptive / "ic_launcher_background.png"
    )

    res_xml = ROOT / "android" / "mipmap-anydpi-v26"
    res_xml.mkdir(parents=True, exist_ok=True)
    adaptive_xml = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""
    (res_xml / "ic_launcher.xml").write_text(adaptive_xml, encoding="utf-8")
    (res_xml / "ic_launcher_round.xml").write_text(adaptive_xml, encoding="utf-8")


def generate_web(src: Image.Image) -> None:
    out = ROOT / "web"
    out.mkdir(parents=True, exist_ok=True)

    save_square(src, out / "favicon-16x16.png", 16)
    save_square(src, out / "favicon-32x32.png", 32)
    save_square(src, out / "favicon-48x48.png", 48)

    ico_img = src.copy()
    ico_img.save(
        out / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64)],
    )

    save_square(src, out / "apple-touch-icon.png", 180)
    save_square(src, out / "icon-192.png", 192)
    save_square(src, out / "icon-512.png", 512)

    padded_on_color(src, 192, 0.80, EMBER_ORANGE).save(
        out / "icon-maskable-192.png"
    )
    padded_on_color(src, 512, 0.80, EMBER_ORANGE).save(
        out / "icon-maskable-512.png"
    )

    manifest = {
        "name": "벼린 — 노동자의 지갑",
        "short_name": "벼린",
        "description": "TTL 생태계 공식 월렛. 노동자의 지갑.",
        "start_url": "/",
        "display": "standalone",
        "background_color": "#0B0B0D",
        "theme_color": "#E84D1A",
        "icons": [
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {
                "src": "/icon-maskable-192.png",
                "sizes": "192x192",
                "type": "image/png",
                "purpose": "maskable",
            },
            {
                "src": "/icon-maskable-512.png",
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "maskable",
            },
        ],
    }
    (out / "manifest.webmanifest").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    head_snippet = """<!-- 벼린 favicon / PWA / iOS Safari -->
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#E84D1A">
"""
    (out / "head-snippet.html").write_text(head_snippet, encoding="utf-8")


def generate_windows(src: Image.Image) -> None:
    out = ROOT / "windows"
    out.mkdir(parents=True, exist_ok=True)

    composite_on_color(src, 70, NIGHT_ANVIL).save(out / "mstile-70x70.png")
    composite_on_color(src, 150, NIGHT_ANVIL).save(out / "mstile-150x150.png")
    composite_on_color(src, 270, NIGHT_ANVIL).save(out / "mstile-270x270.png")
    composite_on_color(src, 310, NIGHT_ANVIL).save(out / "mstile-310x310.png")

    wide = Image.new("RGB", (310, 150), NIGHT_ANVIL)
    tile = resize(src, 130).convert("RGB")
    wide.paste(tile, ((310 - 130) // 2, (150 - 130) // 2))
    wide.save(out / "mstile-310x150.png")

    browserconfig = """<?xml version="1.0" encoding="utf-8"?>
<browserconfig>
  <msapplication>
    <tile>
      <square70x70logo src="/mstile-70x70.png"/>
      <square150x150logo src="/mstile-150x150.png"/>
      <square310x310logo src="/mstile-310x310.png"/>
      <wide310x150logo src="/mstile-310x150.png"/>
      <TileColor>#0B0B0D</TileColor>
    </tile>
  </msapplication>
</browserconfig>
"""
    (out / "browserconfig.xml").write_text(browserconfig, encoding="utf-8")


def generate_macos(src: Image.Image) -> None:
    out = ROOT / "macos" / "icon.iconset"
    out.mkdir(parents=True, exist_ok=True)

    sizes = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for px, name in sizes:
        save_square(src, out / name, px)

    readme = """# macOS .icns 생성

이 폴더(icon.iconset)에서 다음 명령 실행:

    iconutil -c icns icon.iconset

→ icon.icns 가 생성됩니다. macOS Xcode 프로젝트의 Assets.xcassets에 드래그.
"""
    (out.parent / "README.md").write_text(readme, encoding="utf-8")


def generate_social(src: Image.Image) -> None:
    out = ROOT / "social"
    out.mkdir(parents=True, exist_ok=True)

    dark_src_path = Path(r"D:\TTLCOINWalet\logo0_dark.png")
    dark_src = (
        Image.open(dark_src_path).convert("RGBA")
        if dark_src_path.exists()
        else src
    )

    for name, w, h in [("og-image.png", 1200, 630), ("twitter-card.png", 1200, 675)]:
        canvas = Image.new("RGB", (w, h), NIGHT_ANVIL)
        logo_size = int(h * 0.85)
        logo = resize(dark_src, logo_size).convert("RGB")
        canvas.paste(logo, ((w - logo_size) // 2, (h - logo_size) // 2))
        canvas.save(out / name)

    for name, w, h in [
        ("og-image-light.png", 1200, 630),
        ("twitter-card-light.png", 1200, 675),
    ]:
        canvas = Image.new("RGB", (w, h), PAPER_WHITE)
        logo_size = int(h * 0.85)
        logo = resize(src, logo_size).convert("RGB")
        canvas.paste(logo, ((w - logo_size) // 2, (h - logo_size) // 2))
        canvas.save(out / name)


def write_index() -> None:
    index = """# 벼린 브랜드 아이콘 패키지

원본: logo0.png (2048×2048)
생성일: 2026-05-18

## 폴더 구조

- **ios/AppIcon.appiconset/**   — Xcode에 통째로 드래그
- **android/mipmap-*dpi/**      — Android Studio res/ 에 복사
- **android/adaptive/**         — Adaptive Icon (Oreo+) fg/bg
- **android/mipmap-anydpi-v26/** — Adaptive Icon XML
- **web/**                      — favicon + PWA + head-snippet.html
- **windows/**                  — Microsoft Tiles + browserconfig.xml
- **macos/icon.iconset/**       — `iconutil -c icns` 명령으로 .icns 생성
- **social/**                   — OG / Twitter 카드 (다크 배경)

## 즉시 적용

### 웹사이트
web/head-snippet.html 의 내용을 <head> 안에 붙여넣기.
web/ 안의 파일들을 사이트 루트에 그대로 업로드.

### iOS Xcode
ios/AppIcon.appiconset 폴더 통째로 Xcode 프로젝트의
Assets.xcassets 안으로 드래그.

### Android Studio
android/mipmap-*dpi 폴더들을 app/src/main/res/ 아래로 복사.
android/mipmap-anydpi-v26/ 도 함께.

### macOS
macos/icon.iconset 폴더에서:
    iconutil -c icns icon.iconset
"""
    (ROOT / "README.md").write_text(index, encoding="utf-8")


def count_files(path: Path) -> int:
    return sum(1 for p in path.rglob("*") if p.is_file())


def main() -> None:
    if not SRC.exists():
        print(f"ERROR: source not found: {SRC}", file=sys.stderr)
        sys.exit(1)

    clean_dist()
    src = Image.open(SRC).convert("RGBA")

    print("[1/7] iOS AppIcon.appiconset...")
    generate_ios(src)
    print("[2/7] Android mipmap + Adaptive...")
    generate_android(src)
    print("[3/7] Web favicon + PWA manifest...")
    generate_web(src)
    print("[4/7] Windows Tiles + browserconfig...")
    generate_windows(src)
    print("[5/7] macOS .iconset...")
    generate_macos(src)
    print("[6/7] Social OG / Twitter...")
    generate_social(src)
    print("[7/7] README + index...")
    write_index()

    total = count_files(ROOT)
    print(f"\nDone. {total} files generated at: {ROOT}")


if __name__ == "__main__":
    sys.exit(main())
