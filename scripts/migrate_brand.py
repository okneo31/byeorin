"""벼린 브랜드 마이그레이션 — 일괄 텍스트 치환.

매핑 규칙 (순서 중요):
  슬로건/속담은 placeholder 로 보호 → 본 치환 → 복원.

사용법:
  python scripts/migrate_brand.py           # dry-run (변경 미적용, 통계만)
  python scripts/migrate_brand.py --apply   # 실제 적용

제외:
  node_modules, .git, .wxt, dist, build, target, .next, icons/dist
  바이너리 (.png, .jpg, .svg, .ico, .ttf, .otf, .woff*)
  lock 파일 (pnpm-lock.yaml, package-lock.json, Cargo.lock)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(r"D:\TTLCOINWalet")

ALLOWED_EXTS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json",
    ".md", ".txt", ".yaml", ".yml", ".toml",
    ".c", ".h", ".conf", ".overlay", ".cmake",
    ".css", ".html", ".rs", ".xml", ".svg",
}
ALLOWED_NAMES = {"Kconfig", "CMakeLists.txt", "west.yml", "module.yml"}

EXCLUDE_DIRS = {
    "node_modules", ".git", ".wxt", "dist", "build", "target",
    ".next", ".turbo", ".cache", "icons", "branding",
}
EXCLUDE_FILES = {
    "pnpm-lock.yaml", "package-lock.json", "Cargo.lock",
    "migrate_brand.py",
}


SLOGAN_PROTECTED = "__SLOGAN_LABOR_FREES_WORLD__"

PROTECT_FIRST: list[tuple[str, str]] = [
    ("노동자의 지갑이 세상을 자유롭게", SLOGAN_PROTECTED),
]

MAIN_RULES: list[tuple[str, str]] = [
    ("nrf52840_nodong_cold", "nrf52840_byeorin_yose"),
    ("nodong_cold", "byeorin_yose"),
    ("NODONG_COLD", "BYEORIN_YOSE"),
    ("노동자의 지갑 Cold", "벼린 요세"),
    ("노동자의 지갑 콜드", "벼린 요세"),
    ("Nodong Cold", "Byeorin Yose"),
    ("NodongCold", "ByeorinYose"),
    ("ByeorinCold", "ByeorinYose"),
    ("byeorinCold", "byeorinYose"),
    ("BYEORIN_COLD", "BYEORIN_YOSE"),
    ("BYEORINCOLD", "BYEORINYOSE"),

    ("@nodong/", "@byeorin/"),
    ("nodong-wallet", "byeorin-wallet"),

    ("NODONG_", "BYEORIN_"),
    ("NODONG", "BYEORIN"),
    ("Nodong", "Byeorin"),
    ("nodong", "byeorin"),

    ("노동자의 지갑", "벼린"),
]

RESTORE_LAST: list[tuple[str, str]] = [
    (SLOGAN_PROTECTED, "노동자의 지갑이 세상을 자유롭게"),
]


def should_include_file(p: Path) -> bool:
    if p.name in EXCLUDE_FILES:
        return False
    if p.name in ALLOWED_NAMES:
        return True
    return p.suffix.lower() in ALLOWED_EXTS


def iter_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for name in filenames:
            p = Path(dirpath) / name
            if should_include_file(p):
                yield p


def read_text(p: Path) -> str | None:
    for enc in ("utf-8", "utf-8-sig", "cp949"):
        try:
            return p.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return None


def apply_rules(text: str) -> tuple[str, dict[str, int]]:
    counts: dict[str, int] = {}
    for before, after in PROTECT_FIRST + MAIN_RULES + RESTORE_LAST:
        if before in text:
            counts[before] = counts.get(before, 0) + text.count(before)
            text = text.replace(before, after)
    return text, counts


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually apply changes")
    args = ap.parse_args()

    files = list(iter_files(ROOT))
    print(f"Scanning {len(files)} files (mode={'APPLY' if args.apply else 'dry-run'})")
    print()

    total_files_changed = 0
    total_replacements = 0
    aggregated: dict[str, int] = {}
    changed_files: list[Path] = []

    for p in files:
        original = read_text(p)
        if original is None:
            continue
        new_text, counts = apply_rules(original)
        if not counts:
            continue
        total_files_changed += 1
        for k, v in counts.items():
            aggregated[k] = aggregated.get(k, 0) + v
            total_replacements += v
        changed_files.append(p)
        if args.apply:
            p.write_text(new_text, encoding="utf-8")

    print("=== Replacement counts (across all files) ===")
    for before, total in sorted(aggregated.items(), key=lambda x: -x[1]):
        if before == SLOGAN_PROTECTED:
            continue
        print(f"  {total:>5}x  {before}")

    print()
    print(f"Files affected: {total_files_changed}")
    print(f"Total replacements: {total_replacements}")
    if not args.apply:
        print()
        print(f"DRY-RUN. Re-run with --apply to write changes.")
        print(f"First 10 affected files:")
        for p in changed_files[:10]:
            print(f"  {p.relative_to(ROOT)}")
    else:
        print(f"APPLIED. All changes written.")


if __name__ == "__main__":
    sys.exit(main())
