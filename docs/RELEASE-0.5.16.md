# 릴리스 v0.5.16 — 배포 파일명에 버전 포함

작성 2026-08-01 · 근거는 전부 이 문서 작성 시점의 직접 실행 출력이다.

---

## 1. 결론

- 파일명 체계 전환: **성공**. 산출물이 고정 `벼린.apk` 에서 `벼린<versionName>.apk` 로 바뀌었고, 이름은 `apps/android/android/app/build.gradle` 의 `versionName` 에서 읽어 조립된다(하드코딩 없음, 2절 실증).
- APK 산출: **됨. 서명됨**(v2 서명, 인증서 지문 `303f801b…f103480`).
- 최종 산출물
  - 경로 `D:\TTLCOINWalet\벼린0.5.16.apk`
  - 크기 `5,545,288 B` (직전 0.5.15 = 5,542,132 B, 차이 +3,156 B)
  - sha256 `8edcb5624b73c927a6a43626d0efa5c0730e2bb1dd9128fe5bcc85a3f811dc8a`
  - 짝 매니페스트 `D:\TTLCOINWalet\벼린0.5.16.apk.manifest.json` (현재 **미추적** — 커밋해야 추적됨)
- 미완: 문서 4곳이 아직 옛 이름을 사실처럼 기술한다(7절). 이 문서 기준 **릴리스 완료 아님**.

---

## 2. 파일명 규칙과 조립 실증

형식
```
산출물     벼린<versionName>.apk
매니페스트 벼린<versionName>.apk.manifest.json
```

조립 경로 (코드 실측)
- `apps/android/scripts/gradle.mjs` — `readVersionName()` 이 build.gradle 을 `/versionName\s+"([^"]+)"/` 로 읽는다. 읽기 실패·미매치면 `fail()` 로 exit 1. 옛 이름으로의 무성 폴백 없음.
- `apps/android/scripts/release-manifest.mjs` — `apkFileName()` 이 기존 `readVersion()` 을 재사용해 같은 이름을 만들고, 매니페스트는 `${manifest.artifact}.manifest.json` 으로 쓴다. `artifact` 필드는 `basename(apkPath)`.

실증(감사 부대 실험, 원복 확인됨): build.gradle 의 versionName 을 `0.5.16` → `9.9.9` 로 임시 변경 후 인자 없이 `node apps/android/scripts/release-manifest.mjs` 실행 → `벼린9.9.9.apk.manifest.json` 생성. 즉 이름은 build.gradle 한 곳에서만 나온다. 원복 후 `git diff apps/android/android/app/build.gradle` = versionCode 16→17, versionName 0.5.15→0.5.16 **두 줄뿐**, 9.9.9 흔적 0. 이 문서 작성 시점 `git status` 에도 9.9.9 잔재 없음(직접 확인).

.gitignore 실증
```
.gitignore:55:/벼린*.apk   벼린0.5.16.apk     ← 무시됨
.gitignore:55:/벼린*.apk   벼린.apk           ← 무시됨
(벼린0.5.16.apk.manifest.json / 벼린.apk.manifest.json → 출력 없음 = 추적 대상)
```

---

## 3. 변경 파일

| 파일 | 무엇이 바뀌었나 | 소비처 영향 |
|---|---|---|
| `apps/android/android/app/build.gradle` | versionCode 16→17, versionName 0.5.15→0.5.16 | 파일명·매니페스트·앵커 페이로드의 **단일 출처** |
| `apps/android/scripts/gradle.mjs` | `readVersionName()` 추가, 복사 대상 `벼린<ver>.apk`, 산출물 로그에 배포명 표기 | release 빌드 결과물 위치 변경 |
| `apps/android/scripts/release-manifest.mjs` | `artifact = basename()`, `apkFileName()` export, 더러움 제외를 정규식 `/^벼린[\d.]*\.apk(\.manifest\.json)?$/` 로, 출력 경로를 artifact 기준으로 | 매니페스트 파일명·내용 |
| `scripts/verify-byeorin-apk.mjs` | 인자 없으면 `벼린*.apk` 탐색(0개·2개 이상이면 exit 2), 매니페스트는 `<APK>.manifest.json` 유도 | 사용자 검증 명령 |
| `scripts/anchor-release.mjs` | 매니페스트 경로를 versionName 으로 조립, 없으면 옛 파일로 폴백하고 로그 표기 | 온체인 앵커 입력. **페이로드 형식 무변경**(파일명 미포함) → 과거 앵커와 호환 |
| `.gitignore` | `/벼린.apk` → `/벼린*.apk` | 새 산출물도 무시, manifest 는 계속 추적 |
| `README.md` · `SECURITY.md` · `docs/VERIFIABILITY.md` | 파일명 규칙 문단 + 검증 예시 갱신 | 사용자 안내 |
| `docs/CHANGELOG.md` · `docs/CONTEXT.md` | v0.5.16 항목·현재 버전·파일 트리 갱신 | 인수인계 |
| `packages/wallet-sdk/src/btc-history/bip157/scan.ts` | **이번 파일명 작업과 무관**. 다른 세션의 미커밋 변경이 같은 트리에 섞여 있다 | 6절 |

---

## 4. 빌드 결과

| 대상 | 성공 | 산출물 | 크기 | 소요 |
|---|---|---|---|---|
| 코어 패키지 5종 (wallet-sdk·design-system·i18n·shell-core·ttl-amm-contracts) | 됨 (exit 0) | `packages/*/dist` | wallet-sdk index.js 330.14 KB 외 | 6.93 s |
| web | 됨 (exit 0) | `apps/web/dist` (12 files) | 22,110,172 B (sourcemap 16.84 MB 포함, 비-map ≈ 4.67 MB) | 12.9 s |
| extension (chrome-mv3) | 됨 (exit 0) | `apps/extension/.output/chrome-mv3` (33 files) | 6,953,578 B | 18.2 s |
| desktop (vite 프론트만) | 됨 (exit 0) | `apps/desktop/dist` | 29,810,806 B (sourcemap 포함) | 14.99 s |
| android release | 됨 (BUILD SUCCESSFUL, 165 tasks: 51 executed / 114 up-to-date) | `벼린0.5.16.apk` + 매니페스트 | 5,545,288 B | 14 s |

- desktop 은 `tauri build`(번들) 미실행 — 스크립트가 `vite build` 뿐. **번들 성공 여부 미확인.**
- 빌드 경고는 전부 기존 사항: node `events`/`crypto` 브라우저 externalize, 500 kB 초과 청크. 실패 아님.
- MV3 CSP 실측: 생성된 manifest.json 의 `extension_pages` = `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';` — 유지됨.

회귀 테스트(이 문서 작성 시 직접 실행)
```
vitest run tests/btc-bip157.test.ts tests/btc-bip157-errors.test.ts tests/btc-bip157-reorg.test.ts
→ 3 files / 118 passed / 0 failed, 1.40 s
```

---

## 5. 검증

| 항목 | 결과 | 근거 |
|---|---|---|
| 해시 재계산 | **일치** | `sha256sum 벼린0.5.16.apk` = `8edcb562…dc8a` = 매니페스트 `sha256` |
| 크기 | **일치** | 실측 5,545,288 B = 매니페스트 `sizeBytes` |
| 서명 | **유효** | apksigner verify --verbose → "Verifies", v2 true, signers 1 |
| 직전 릴리스와 같은 키인가 | **같음** | 실물 `벼린.apk`(0.5.15) 를 apksigner 로 직접 찍은 지문 = `303f801b…f103480` = 0.5.16 지문 = 옛/새 매니페스트 certSha256. DN `CN=Byeorin, OU=TTL Ecosystem, O=Byeorin, L=Seoul, C=KR` |
| 덮어 설치 가능 여부 | **가능** | 같은 키 + 같은 applicationId `top.ttl1.byeorin` + versionCode 17 > 16 |
| versionCode/Name | **일치** | aapt dump badging → versionCode 17 / versionName 0.5.16 = build.gradle = 매니페스트 |
| verify 스크립트 | 인자 지정 시 rc=0 | `node scripts/verify-byeorin-apk.mjs 벼린0.5.16.apk` → 무결성 OK / 진위 OK / 출처 SKIP / 앵커 SKIP |
| verify 스크립트 (인자 없음) | **rc=2 실패** | 루트에 `벼린.apk` 와 `벼린0.5.16.apk` 둘 다 있어 "여러 개". 설계된 동작이나 문서의 기본 명령은 이 상태에서 그대로 통하지 않는다 |

---

## 6. 빌드 시점 소스 상태 — 더러웠다

- HEAD = `aa25ecc` (`fix(btc-history): BIP157 결함 9건 수정 …`), branch `main`.
- 매니페스트 `source.workingTreeClean = **false**`, warning `"커밋되지 않은 변경이 섞인 빌드다. 이 산출물은 소스로 추적할 수 없다."` 가 그대로 기록됐다.
- 이 문서 작성 시점 `git status --short` (직접 실행):
  - 수정 12: `.gitignore` `README.md` `SECURITY.md` `apps/android/android/app/build.gradle` `apps/android/scripts/gradle.mjs` `apps/android/scripts/release-manifest.mjs` `docs/CHANGELOG.md` `docs/CONTEXT.md` `docs/VERIFIABILITY.md` `packages/wallet-sdk/src/btc-history/bip157/scan.ts` `scripts/anchor-release.mjs` `scripts/verify-byeorin-apk.mjs`
  - 미추적 6: `docs/BIP157-REMAINDER-ROUND.md` `docs/JustLedger_정직한장부.md` `docs/opus5.md` `packages/wallet-sdk/tests/btc-bip157-remainder.test.ts` `scripts/remainder-out/` `벼린0.5.16.apk.manifest.json`
  - `git diff --stat` = 12 files changed, 367 insertions(+), 73 deletions(-)
- `scan.ts` 는 이번 파일명 작업이 아니라 **다른 세션의 BIP157 작업분**이며, 그 상태로 APK 에 들어갔다.
- 따라서 현재 `벼린0.5.16.apk` 는 **소스로 추적 불가능한 빌드**다. 커밋 후 재빌드하면 `workingTreeClean = true` 인 매니페스트가 나온다. 지금 파일을 그대로 배포하면 검증 결과의 "출처" 항목은 계속 SKIP 이다.

---

## 7. 남은 것

**미완 (코드/문서 수정 필요) — 총 4곳, 실측**
```
apps/android/README.md:141  산출물 트리 `D:\TTLCOINWalet\벼린.apk` — 현행 동작과 다름
apps/android/README.md:144  "저장소 루트의 벼린.apk 로 항상 복사된다" — 주장 자체가 거짓이 됨(문단 재작성 필요)
apps/android/README.md:150  "새 벼린.apk 를 덮어 설치하면" — 사실관계는 맞고 이름만 틀림
apps/android/src/app-version.ts:3  주석 "항상 같은 파일명(벼린.apk)으로 덮어쓰기 때문에" — 존재 이유가 부분 무효(로직은 정상)
```
작업량 = (141행 1줄 치환 + 144행 2~3줄 재작성 + 150행 1줄 치환 + 주석 1줄) 4개 편집 × 2분 = **약 8분**.

**사람 결정 필요**
1. 옛 `벼린.apk.manifest.json`(git 추적 중) 처리. 감사 판정은 **남긴다 + 이름도 바꾸지 않는다** — 이미 배포된 0.5.15 APK 의 유일한 검증 근거이고, 내부 `artifact` 가 `"벼린.apk"` 라 rename 하면 `<APK>.manifest.json` 유도 규칙과 짝이 깨진다. 다만 "옛 이름 매니페스트는 0.5.15 이전용"이라는 한 줄이 **어느 문서에도 없다** — 추가 필요.
2. 로컬 루트의 옛 `벼린.apk`(5,542,132 B) 존치 여부. 두면 인자 없는 verify 가 계속 rc=2. gitignore 대상이라 저장소 영향은 없다.
3. 커밋 시점. 지금 커밋하고 재빌드해야 clean 매니페스트가 나온다. 미추적 6건(특히 `scripts/remainder-out/`, `docs/opus5.md`) 을 커밋할지 지울지도 함께 정해야 한다.
4. `벼린0.5.16.apk.manifest.json` 을 커밋해야 공개 검증 근거가 된다(현재 미추적).

**미검증**
- `tauri build` 데스크톱 번들.
- web/extension 런타임 로드 테스트(빌드 산출물만 확인).
- 실기기 설치·덮어쓰기 업데이트(같은 키·versionCode 증가로 가능하다고 판단했을 뿐, 실행 안 함).
- 온체인 앵커 전송(하지 않음).
- build.gradle 문법은 실제 gradle 빌드가 통과했으므로 확인됨.

---

## 8. 산출물·임시파일 경로

산출물
```
D:\TTLCOINWalet\벼린0.5.16.apk                  5,545,288 B  (gitignore 대상)
D:\TTLCOINWalet\벼린0.5.16.apk.manifest.json        1,086 B  (미추적 — 커밋 필요)
D:\TTLCOINWalet\apps\web\dist
D:\TTLCOINWalet\apps\extension\.output\chrome-mv3
D:\TTLCOINWalet\apps\desktop\dist
D:\TTLCOINWalet\packages\*\dist
```

이전 릴리스 잔여 (삭제 대상 후보, 이 문서에서는 지우지 않음)
```
D:\TTLCOINWalet\벼린.apk                        5,542,132 B  (0.5.15, gitignore 대상)
D:\TTLCOINWalet\벼린.apk.manifest.json              1,080 B  (git 추적 — 감사 판정: 남긴다)
```

임시파일
```
D:\TTLCOINWalet\scripts\release-out\   → 존재하지 않음(각 부대가 이미 정리)
D:\TTLCOINWalet\scripts\remainder-out\ → 미추적 상태로 남아 있음. 이번 파일명 작업 산출물 아님(BIP157 라운드). 삭제 대상 후보 — 판정 전이라 지우지 않았다.
```
감사 부대가 보고한 `probe.apk.manifest.json` · `벼린9.9.9.apk.manifest.json` 은 이 문서 작성 시점 `git status`·디렉터리 목록에 **없다**(이미 정리됨, 직접 확인).
