"""아이콘 자산을 각 앱의 적절한 위치로 배포.

원본: D:\\TTLCOINWalet\\icons\\dist\\ (generate_all_icons.py 산출물)

배포 대상:
  apps/web/public/                           — favicon, apple-touch, og
  apps/extension/public/icon/                — 16/32/48/128
  apps/desktop/src-tauri/icons/              — tauri.conf.json 명시 경로
  apps/mobile/assets/                        — RN bare용 (생성 필요시)

기존 파일은 백업 없이 덮어쓰기 (git이 안전망).
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

DIST = Path(r"D:\TTLCOINWalet\icons\dist")
ROOT = Path(r"D:\TTLCOINWalet")


PLAN = [
    # (src 상대경로, dst 절대경로)
    (DIST / "web" / "favicon.ico",          ROOT / "apps/web/public/favicon.ico"),
    (DIST / "web" / "favicon-32x32.png",    ROOT / "apps/web/public/favicon.png"),
    (DIST / "web" / "apple-touch-icon.png", ROOT / "apps/web/public/apple-touch-icon.png"),
    (DIST / "social" / "og-image.png",      ROOT / "apps/web/public/og.png"),
    (DIST / "social" / "og-image-light.png",ROOT / "apps/web/public/og.jpg"),
    (DIST / "web" / "manifest.webmanifest", ROOT / "apps/web/public/manifest.webmanifest"),

    (DIST / "web" / "favicon-16x16.png", ROOT / "apps/extension/public/icon/16.png"),
    (DIST / "web" / "favicon-32x32.png", ROOT / "apps/extension/public/icon/32.png"),
    (DIST / "web" / "favicon-48x48.png", ROOT / "apps/extension/public/icon/48.png"),
    (DIST / "web" / "icon-192.png",      ROOT / "apps/extension/public/icon/128.png"),

    (DIST / "macos" / "icon.iconset" / "icon_32x32.png",   ROOT / "apps/desktop/src-tauri/icons/32x32.png"),
    (DIST / "macos" / "icon.iconset" / "icon_128x128.png", ROOT / "apps/desktop/src-tauri/icons/128x128.png"),
    (DIST / "macos" / "icon.iconset" / "icon_256x256.png", ROOT / "apps/desktop/src-tauri/icons/128x128@2x.png"),
    (DIST / "web" / "favicon.ico",                          ROOT / "apps/desktop/src-tauri/icons/icon.ico"),

    (DIST / "macos" / "icon.iconset", ROOT / "apps/desktop/src-tauri/icons/icon.iconset"),

    (DIST / "ios" / "AppIcon.appiconset", ROOT / "apps/mobile/assets/AppIcon.appiconset"),
    (DIST / "android",                    ROOT / "apps/mobile/assets/android-icons"),
]


def copy_one(src: Path, dst: Path) -> str:
    if not src.exists():
        return f"  MISS  {src.relative_to(ROOT)}"
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        files = sum(1 for _ in dst.rglob("*") if _.is_file())
        return f"  COPY  {src.relative_to(ROOT)} -> {dst.relative_to(ROOT)} ({files} files)"
    shutil.copy2(src, dst)
    return f"  COPY  {src.relative_to(ROOT)} -> {dst.relative_to(ROOT)}"


def main() -> None:
    if not DIST.exists():
        print(f"ERROR: dist not found: {DIST}", file=sys.stderr)
        sys.exit(1)

    for src, dst in PLAN:
        print(copy_one(src, dst))

    print()
    print(f"Done. Distributed to {len(PLAN)} target(s).")


if __name__ == "__main__":
    sys.exit(main())
