# 벼린 — Build Environment Setup

This guide installs every external tool the monorepo needs, on
**Windows 11**, **macOS 14+**, and **Debian/Ubuntu Linux**. It is a
single source of truth — `apps/mobile/README-SETUP.md` and the per-app
READMEs assume you have already worked through whichever section
applies to you.

> Run `pnpm setup-check` (from repo root) at any time to see which
> tools are detected on the current machine and which are missing.

---

## 0. What works without anything

The summary table below tells you the *minimum* tool gate for each
deliverable. The "✓ pnpm only" rows are the parts that will work the
moment you have Node ≥ 20.10 and pnpm ≥ 9 — nothing else.

| Deliverable                                       | Needs Node + pnpm | Needs Rust | Needs JDK 17 + Android SDK | Needs Xcode (macOS) |
| ------------------------------------------------- | :---------------: | :--------: | :------------------------: | :-----------------: |
| `pnpm install` (workspace bootstrap)              |         ✓         |            |                            |                     |
| `pnpm -r typecheck` (all packages)                |         ✓         |            |                            |                     |
| `pnpm -r test` (`packages/wallet-sdk`, etc.)      |         ✓         |            |                            |                     |
| `packages/wallet-sdk` build (`tsup`)              |         ✓         |            |                            |                     |
| `packages/shell-core`, `design-system` build      |         ✓         |            |                            |                     |
| `apps/web` Vite dev/build                         |         ✓         |            |                            |                     |
| `apps/extension` Vite dev/build                   |         ✓         |            |                            |                     |
| `apps/desktop` Vite dev (browser-only)            |         ✓         |            |                            |                     |
| `apps/desktop` `tauri dev` / `tauri build`        |         ✓         |     ✓      |                            |                     |
| `apps/mobile` `typecheck` (JS only)               |         ✓         |            |                            |                     |
| `apps/mobile` Android build / run                 |         ✓         |            |             ✓              |                     |
| `apps/mobile` iOS build / run                     |         ✓         |            |                            |          ✓          |
| `scripts/verify-addresses.mjs`                    |         ✓         |            |                            |                     |
| `node scripts/setup-check.mjs`                    |         ✓         |            |                            |                     |

If you only need to hack on JS/TS (wallet-sdk, web shell, extension),
skip everything below `pnpm` and you're done.

---

## 1. Core: Node 20.10+ and pnpm 9+

Required for **everything**. The repo pins `pnpm@9.15.0` via
`packageManager` in root `package.json`, so corepack will resolve it
automatically once Node is installed.

### Install — Windows (PowerShell)

Prefer **scoop** when you don't have admin; **choco** if you do.

```powershell
# scoop (no admin needed)
scoop install nodejs-lts
corepack enable
corepack prepare pnpm@9.15.0 --activate

# OR choco (admin)
choco install nodejs-lts -y
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

### Install — macOS

```sh
brew install node@20
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

### Install — Linux (Debian/Ubuntu)

```sh
# Node official apt repo (nodesource is the canonical option):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

### Verify

```sh
node -v   # expect: v20.10.x or higher (we test on v20, v22)
pnpm -v   # expect: 9.15.x
```

Expected: a v-prefixed semver (e.g. `v22.10.0`) for Node, plain semver
(e.g. `9.15.9`) for pnpm.

---

## 2. Rust toolchain (for `apps/desktop` via Tauri 2)

Tauri compiles a Rust binary that hosts the WebView. You need
`rustc` + `cargo` ≥ 1.77 **plus** platform build dependencies:

- **Windows:** Microsoft Visual C++ build tools (MSVC) — *NOT* MinGW.
  Tauri uses the MSVC ABI; MinGW will link but silently produce broken
  binaries (no Edge WebView2 bridging).
- **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **Linux:** `webkit2gtk` 4.1, `gtk-3`, `libsoup-3`, `librsvg2-dev`,
  `libayatana-appindicator3-dev`.

### Install — Windows (PowerShell)

```powershell
# 1) Install MSVC build tools (admin). The "Desktop development with C++"
#    workload is the minimum.
#    Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/
#    (about 6 GB; this step requires UAC).
#
# 2) Install rustup (no admin):
scoop install rustup
rustup default stable
rustup target add x86_64-pc-windows-msvc

# 3) Install WebView2 runtime — Windows 11 ships with it preinstalled.
#    Verify with:
Get-AppxPackage -Name "Microsoft.WebViewRuntime" -ErrorAction SilentlyContinue
# If empty: download "Evergreen Standalone Installer" from
# https://developer.microsoft.com/microsoft-edge/webview2/
```

### Install — macOS

```sh
xcode-select --install                      # one-time
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup default stable
```

### Install — Linux (Debian/Ubuntu)

```sh
sudo apt update
sudo apt install -y \
  build-essential curl wget file libssl-dev pkg-config \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libsoup-3.0-dev

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup default stable
```

### Verify

```sh
rustc --version    # expect: rustc 1.77 or higher
cargo --version    # expect: cargo 1.77 or higher
```

### Build `apps/desktop`

```sh
pnpm install
pnpm --filter @byeorin/desktop tauri dev          # interactive
pnpm --filter @byeorin/desktop tauri build        # produces installer
pnpm --filter @byeorin/desktop tauri build --no-bundle   # produces only the binary, no installer
```

The `--no-bundle` form skips MSI/DMG/AppImage creation and is the fastest
way to validate that the Rust side compiles. The binary lands at
`apps/desktop/src-tauri/target/release/벼린.exe` (Windows),
`.../target/release/벼린.app` (macOS), or
`.../target/release/벼린` (Linux).

### Gotchas

- **MSVC vs MinGW on Windows:** Tauri detects the active Rust toolchain.
  If `rustup show` lists `stable-x86_64-pc-windows-gnu` as default,
  `tauri build` will silently use MinGW. Fix:
  `rustup default stable-x86_64-pc-windows-msvc`.
- **First build is slow.** `~10 min` for a clean release build; ~30s
  for incremental. The first build downloads ~500MB of crates.
- **`webkit2gtk` 4.1 vs 4.0 on older Linux distros.** Tauri 2 requires
  4.1; Ubuntu 22.04's default packages are 4.0. Either upgrade to 24.04
  or pull `webkit2gtk-4.1-dev` from the Tauri PPA.
- **Korean app name and the `.app` bundle.** macOS keeps the UTF-8 name
  fine, but `cargo build` output filenames will contain `벼린`
  literally — quote them in scripts.

---

## 3. JDK 17 + Android SDK (for `apps/mobile` Android)

React Native 0.76 mandates **JDK 17**. Older JDK 11 will fail in
`gradle build` with cryptic class-version errors.

### Install — Windows (PowerShell)

```powershell
# JDK — Temurin (Eclipse Adoptium) is the canonical RN choice.
scoop bucket add java
scoop install temurin17-jdk
# OR (admin):
choco install temurin17 -y

# Set JAVA_HOME for the current user (persists across shells):
[Environment]::SetEnvironmentVariable("JAVA_HOME", "$HOME\scoop\apps\temurin17-jdk\current", "User")

# Android command-line tools — install Android Studio (it ships the
# whole SDK + emulator) OR fetch just the cmdline-tools:
scoop install android-clt
[Environment]::SetEnvironmentVariable("ANDROID_HOME", "$HOME\scoop\apps\android-clt\current", "User")

# Add SDK platforms — RN 0.76 needs API 34:
sdkmanager --install "platform-tools" "platforms;android-34" "build-tools;34.0.0" "ndk;26.1.10909125"
```

### Install — macOS

```sh
brew install --cask temurin@17
brew install --cask android-studio          # one-stop SDK + emulator + IDE

# Set in ~/.zshrc:
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
```

### Install — Linux (Debian/Ubuntu)

```sh
sudo apt install -y openjdk-17-jdk
# Android Studio is easiest via snap, or manual tarball:
sudo snap install android-studio --classic
# Or manual: https://developer.android.com/studio (extract to ~/android-studio)

# Add to ~/.bashrc:
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin"
```

### Verify

```sh
java -version       # expect: openjdk version "17.0.x"
javac -version      # expect: javac 17.0.x
echo $JAVA_HOME     # expect: nonempty path
echo $ANDROID_HOME  # expect: nonempty path
adb --version       # expect: "Android Debug Bridge version 1.0.x"
```

### Generate `apps/mobile/{ios,android}` (one-time)

The native folders are **intentionally not committed** because they
require this toolchain to scaffold. To generate them:

```sh
cd /tmp
npx @react-native-community/cli@latest init ByeorinMobileTemplate \
  --version 0.76.1 --skip-install --skip-git-init
# Copy ios/ and android/ from /tmp/ByeorinMobileTemplate/ into apps/mobile/
cp -r ByeorinMobileTemplate/ios   /path/to/repo/apps/mobile/ios
cp -r ByeorinMobileTemplate/android /path/to/repo/apps/mobile/android
```

Then edit:
- `apps/mobile/android/app/src/main/res/values/strings.xml` → `app_name` = `벼린`
- Android `applicationId` (in `apps/mobile/android/app/build.gradle`)
  and iOS bundle identifier → e.g. `top.ttl1.byeorin.mobile`
- Native `MainActivity` / `AppDelegate` module name must match
  `apps/mobile/app.json`'s `name` (`ByeorinMobile`)

### Build & run

```sh
pnpm --filter @byeorin/mobile start          # Metro bundler
pnpm --filter @byeorin/mobile android        # device or emulator
```

### Gotchas

- **NDK version pin.** RN 0.76 expects NDK `26.1.10909125`. Newer NDKs
  build but emit warnings; older NDKs fail with linker errors on
  `react-native-keychain`. Pin via `android/build.gradle`:
  `ndkVersion = "26.1.10909125"`.
- **`react-native-keychain` needs `minSdkVersion >= 24`** for biometry.
  Default RN template sets 21 — bump it manually.
- **gradle-wrapper, not host gradle.** The RN template ships its own
  `gradlew` / `gradlew.bat`. Host gradle is only useful for ad-hoc
  inspection (`gradle tasks`); the build uses the wrapper.
- **`adb devices` shows "unauthorized".** Open the USB-debug prompt on
  the device. Wireless debugging needs `adb pair <ip>:<port>` first.
- **Emulator on Linux:** needs KVM. `sudo apt install qemu-kvm` then
  add yourself to the `kvm` group.

---

## 4. Xcode (for `apps/mobile` iOS, macOS only)

iOS builds are macOS-only. Xcode 15 or 16 (release channel — *not*
beta — beta channels regularly break `react-native-svg`'s pod build).

### Install

```sh
# 1) From Mac App Store: Xcode 15.x
# 2) Accept license + install command-line components:
sudo xcodebuild -license accept
xcode-select --install

# 3) CocoaPods (RN uses Pods for native deps):
brew install cocoapods
# OR: sudo gem install cocoapods
```

### Verify

```sh
xcrun --version         # expect: xcrun version 64 or higher
xcodebuild -version     # expect: Xcode 15.x or 16.x
pod --version           # expect: 1.15.x
```

### Build & run

```sh
cd apps/mobile/ios
pod install
cd -
pnpm --filter @byeorin/mobile ios
```

### Gotchas

- **Xcode beta channel.** `react-native-svg` and `react-native-keychain`
  ship Pod specs that pin to release-channel SDK versions. If you're on
  a beta, switch back: `sudo xcode-select -s /Applications/Xcode.app`.
- **M-series Mac arch.** `pod install` on Apple Silicon sometimes
  requires `arch -x86_64 pod install` for older Pods. Most RN 0.76
  deps are native arm64; only legacy ones need this.
- **Bundle identifier conflict.** Two devs cannot deploy to the same
  iCloud account with the same bundle ID. Either use individual
  developer teams or append `-${USER}` to the bundle ID during dev.

---

## 5. Quick-reference commands per app

After completing the relevant sections above:

```sh
# Everyone (no native toolchain needed):
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm -r build

# Desktop (needs Rust):
pnpm --filter @byeorin/desktop tauri dev
pnpm --filter @byeorin/desktop tauri build --no-bundle

# Mobile JS only (no native toolchain needed):
pnpm --filter @byeorin/mobile typecheck

# Mobile Android (needs JDK 17 + Android SDK):
pnpm --filter @byeorin/mobile start
pnpm --filter @byeorin/mobile android

# Mobile iOS (needs macOS + Xcode):
pnpm --filter @byeorin/mobile ios

# Web / extension (no native toolchain needed):
pnpm --filter @byeorin/web dev
pnpm --filter @byeorin/extension dev
```

---

## 6. Troubleshooting checklist

If a build fails, work through these in order before opening an issue:

1. `pnpm setup-check` — am I missing a tool?
2. `rm -rf node_modules apps/*/node_modules packages/*/node_modules` and
   `pnpm install` — pnpm hoisting bug after upgrading a workspace dep.
3. **Tauri:** delete `apps/desktop/src-tauri/target/` and rebuild.
   The cargo incremental cache occasionally corrupts after host
   toolchain upgrades.
4. **Mobile Android:** `cd apps/mobile/android && ./gradlew clean`.
5. **Mobile iOS:** `cd apps/mobile/ios && pod deintegrate && pod install`.
6. **Mobile Metro cache:** `pnpm --filter @byeorin/mobile start --reset-cache`.

---

## 7. CI parity

`.github/workflows/` is the canonical target environment. Match versions
there to your local install when behaviour diverges. The matrix tests
Node 20 + 22 on ubuntu/windows for JS/TS, Rust stable on all three OSes
for Tauri, and a macOS-only job for the iOS smoke build.
