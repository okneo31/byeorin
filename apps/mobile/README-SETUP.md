# 벼린 — Mobile (React Native Bare)

This package is the React Native (bare workflow, TypeScript) shell for the
TTL ecosystem multi-chain wallet. It depends on `@byeorin/wallet-sdk` via the
pnpm workspace.

## Status

- JS/TS app source is scaffolded under `App.tsx`, `src/screens/`, `src/store.ts`.
- `metro.config.js`, `babel.config.js`, `tsconfig.json` are wired for the
  pnpm monorepo layout.
- **Native projects (`ios/`, `android/`) are NOT yet committed.** They must be
  generated on a machine with the full RN toolchain (see below).

## Install (any machine)

```sh
cd apps/mobile
pnpm install --filter @byeorin/mobile
pnpm --filter @byeorin/mobile typecheck
```

`typecheck` should pass without the native projects in place — it only validates
the JS/TS layer.

## Generating the native projects

The native folders are intentionally not committed because they require the
React Native CLI to be run with a working JDK / Xcode / Android SDK. To bring
them in:

1. Install a working RN environment (Node 20+, JDK 17, Android Studio with
   API 34 + NDK, and Xcode 15+ on macOS).
2. From a fresh scratch directory, run:
   ```sh
   npx @react-native-community/cli@latest init ByeorinMobileTemplate --version 0.76.1 --skip-install
   ```
3. Copy the generated `ios/` and `android/` folders into `apps/mobile/`.
4. Edit:
   - `android/app/src/main/res/values/strings.xml` → `app_name` = `벼린`.
   - Android `applicationId` and iOS bundle identifier → e.g. `top.ttl1.byeorin`.
   - The native `MainActivity` / `AppDelegate` module name must match
     `app.json`'s `name` (`ByeorinMobile`).
5. Link `react-native-svg` / `react-native-qrcode-svg` / `react-native-keychain`:
   - iOS: `cd ios && pod install`
   - Android: autolinking handles it; ensure `minSdkVersion >= 24` for
     `react-native-keychain` BIOMETRY support.

## Build & run (requires native toolchain)

```sh
pnpm --filter @byeorin/mobile start          # Metro bundler
pnpm --filter @byeorin/mobile android        # needs Android SDK + emulator/device
pnpm --filter @byeorin/mobile ios            # needs macOS + Xcode
```

## What is wired in v0.1

- TTL mainnet (chainId 7777, RPC `https://rpc.ttl1.top`) via `EvmAdapter`.
- Create / recover BIP-39 wallet (Korean wordlist default for creation).
- Account screen: address + QR + native balance.
- Send screen: native TTL transfer.

## Deferred

- Native projects `ios/` and `android/` (require JDK + Xcode).
- `react-native-keychain` persistence — declared as a dep, not yet wired.
  Mnemonic currently lives in module-scope memory only (see TODO in
  `src/store.ts`).
- Biometric unlock (TouchID / FaceID / Android BiometricPrompt).
- Push notifications.
- Multi-chain UI (BTC / Cosmos / XRP adapters exist in the SDK but the mobile
  UI is EVM/TTL-only in v0.1).
