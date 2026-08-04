# 벼린 v0.5.17 릴리스 보고서

작성 2026-08-04. 모든 수치는 이 문서 작성 시점에 직접 실행해 실측한 값이다.

---

## 1. 결론

| 항목 | 판정 |
|---|---|
| 계정 이름 편집 — 4종 셸 전부 지원 | **맞음** (web·extension·android·desktop 모두 `setAccountLabel` 호출부 존재) |
| v0.5.17 산출물 5종 생성 | **맞음** (APK·MSI·NSIS·확장 chrome-mv3·web dist) |
| QR 스캔이 APK 에 실제로 들어갔는가 | **맞음** (0.5.17 번들에 `jsQR` 1회, 0.5.16 번들에는 0회) |
| 서명 키가 0.5.15·0.5.16 과 같은가 | **맞음** (certSha256 303f801b…f103480 동일 → 덮어 설치 가능) |
| 빌드 시점 소스가 커밋된 상태였는가 | **틀림** (workingTreeClean=false) |

기준선 회귀 없음:
- `pnpm -r build` EXIT=0
- wallet-sdk 681 통과 / 0 실패 (10 skip)
- shell-core 95 통과 / 0 실패 (기존 86 + 계정 라벨 9)
- i18n 19 통과 / 0 실패

---

## 2. 계정 이름 편집

### API
`packages/shell-core/src/store.ts:205`

```
async setAccountLabel(idx: number, label: string | null): Promise<void>
```

- 식별자가 `idx` 인 이유: `Slot` 에 id/uuid 필드가 없고, 기존 계정 API 전부(`selectAccount` / `removeAccount` / `exportPrivateKey` / `exportMnemonic`)가 idx 기반이다.
- 본보기는 `packages/shell-core/src/addressbook.ts:121 updateLabel(id, label)` — 같은 모양(식별자 + 새 라벨, void 반환, 저장까지 수행). 새 패턴을 만들지 않았다.
- 차이 1건: 없는 id 를 조용히 무시하는 addressbook 과 달리, store 는 `assertIndex` 로 `account.not_found` 를 throw 한다. store 의 다른 idx API 가 전부 그렇게 하고 있다.

### 저장 위치
라벨 → `Slot.label` → `persist()` 가 SessionBlobV2 로 직렬화 → 세션 write.
android·desktop 은 그 세션이 `EncryptedKeystoreStore` 이므로 라벨은 **평문 메타가 아니라 scrypt + AES-256-GCM 금고 안**에 들어간다. 확장은 chrome.storage.session, 웹은 메모리.

비밀번호 재입력 **불필요함**. 잠금 해제 상태에서 passphrase 가 이미 메모리에 캐시되어 있고, write 는 350ms 디바운스로 백그라운드에 넘어간다.

### 4종 진입점 (전부 활성 계정 카드 1곳)

| 셸 | 파일:라인 |
|---|---|
| web | apps/web/src/screens/Account.tsx:108 |
| android | apps/android/src/App.tsx:602 |
| desktop | apps/desktop/src/views/Wallet.tsx:206 |
| extension | apps/extension/entrypoints/popup/App.tsx:539 |

UI 는 모달이 아니라 인라인 편집(AddressbookPane 의 pendingRemove 패턴과 동형). 보기 모드 = 라벨 + `btn-ghost btn-sm`(`accounts.rename_button`), 편집 모드 = `input maxLength=32` + 저장/취소, Enter=저장 · Escape=취소. CSS 신규 클래스 없음.

비활성 계정 행에는 편집 버튼을 넣지 않았다. 이유: 확장 popup 360px 에서 비활성 행에 버튼이 3개가 되면 줄바꿈이 난다. "선택해서 활성으로 만든 뒤 편집" 경로 하나로 4종의 자리를 일치시켰다.

### 빈 입력 처리
`trim()` 후 빈 문자열이면 4종 모두 `null` 을 넘긴다(web:108, android:1123, desktop:203, ext:1366). store 의 `normalizeLabel` 도 빈 값을 `null` 로 접는다. `label === null` 이면 UI 가 다시 `accounts.no_label` 자동 이름("계정 N")을 쓴다 → **대체 경로 유지됨**.

정규화 규칙: 제어문자 제거 → 연속 공백 1칸 축약 → trim → 빈 값은 null → 32자로 slice(throw 아님).

32자 상한 계산식:
확장 popup 폭 360px − 좌우 패딩 32 − 주소/체브런 영역 약 120 = 라벨 가용 폭 208px.
라틴 문자 약 7px/자 → 208 ÷ 7 ≈ 29자. 이를 덮는 가장 가까운 2의 거듭제곱 = 32.
저장 비용 = 32 UTF-16 × 계정 20개 = 1,280 code unit ≈ 2.5KB 미만 → 암호화 blob·scrypt 시간에 영향 없음.

### i18n
`packages/i18n/src/messages/{en,ko}.ts:351-355` 에 5개 키 추가(rename_button / rename_save / rename_placeholder / rename_failed{reason} / rename_aria). 키 개수 en 596 · ko 596, en-only 0 · ko-only 0.

---

## 3. 산출물 표

| 셸 | 파일 | 크기(B) | 비고 |
|---|---|---|---|
| android | D:/TTLCOINWalet/벼린0.5.17.apk | 5,596,840 | sha256 `b6be2f61b86e830cdedf1a4f6b00a6cd24d989ef94a083db4b559f2a1fdbf057` · versionCode 18 · 서명됨 |
| desktop MSI | apps/desktop/src-tauri/target/release/bundle/msi/벼린_0.5.17_x64_ko-KR.msi | 8,187,904 | |
| desktop NSIS | apps/desktop/src-tauri/target/release/bundle/nsis/벼린_0.5.17_x64-setup.exe | 7,210,433 | |
| extension | apps/extension/.output/chrome-mv3/ | 7,098,334 | manifest.json version = 0.5.17 |
| web | apps/web/dist/ | 23,823,674 | 소스맵 포함. index-CpfT5QDf.js = 5,243,259 B |

버전 파일 7개 전부 0.5.17 실측 확인:
apps/{web,extension,android,desktop}/package.json · apps/android/android/app/build.gradle(versionName "0.5.17", versionCode 18) · apps/desktop/src-tauri/tauri.conf.json · apps/desktop/src-tauri/Cargo.toml:3. Cargo.lock 은 tauri build 가 0.5.17 로 자동 갱신했다.

키스토어 apps/android/android/keystore.properties 존재(301 B, 07-25 생성) → 서명 빌드로 나갔다. 새로 만들지 않았다.

---

## 4. 검증

`node scripts/verify-byeorin-apk.mjs 벼린0.5.17.apk` EXIT=0 → "✅ 이 파일은 매니페스트와 일치합니다."

| 검증 항목 | 결과 |
|---|---|
| 무결성 (SHA-256) | OK — `sha256sum` 직접 재계산값이 매니페스트와 일치 |
| 진위 (서명 인증서) | OK — 303f801bb44af8c494b6e89844fbe86c36bd6f48ab404a4b6c0228fa3f103480 |
| 출처 (커밋) | SKIP — 커밋되지 않은 변경이 섞인 빌드 |
| 온체인 앵커 | SKIP — 이 릴리스에는 앵커 없음 |

서명 동일 키: 0.5.16 매니페스트의 certSha256 과 문자열이 완전히 같다 → 기존 지갑 위에 덮어 설치된다.

버전 일치: APK 내부 AndroidManifest.xml 바이너리 직접 파싱 결과 versionCode = 18, 문자열 풀에 "0.5.17" 존재 / "0.5.16" 없음.

**QR 포함 실증** — 두 APK 를 풀어 웹 번들 문자열을 직접 센 결과:

| 문자열 | 0.5.17 (index-m15QsVls.js) | 0.5.16 (index-DG0TptHT.js) |
|---|---|---|
| `jsQR` | 1 | **0** |
| `이름 변경` | 1 | **0** |
| `rename_button` | 3 | **0** |

→ QR 스캔과 계정 이름 편집 둘 다 0.5.17 APK 번들에 실제로 들어갔고, 0.5.16 APK 에는 둘 다 없다.

---

## 5. 0.5.16 과의 차이 — 왜 버전을 올렸는가

배포된 벼린0.5.16.apk(08-01 14:38, sha256 8edcb562…)는 QR 작업(08-02) **이전** 빌드다. 위 문자열 실측대로 그 APK 에는 스캔 기능이 없다.

같은 `0.5.16` 이름으로 내용이 다른 APK 를 두 번 내면 매니페스트 sha256 은 달라지는데 versionName 은 같아진다 → 어느 파일이 진짜 0.5.16 인지 해시로만 구분되고 검증 체계가 무너진다. 그래서 0.5.16 → 0.5.17, versionCode 17 → 18 로 올렸다. 파일명은 build.gradle 의 versionName 에서 조립되므로 자동으로 `벼린0.5.17.apk` 가 됐다.

0.5.17 에 들어간 것:
1. 계정 이름 편집(신규) — setAccountLabel, 빈 값 → 자동 이름 복귀, 32자 상한.
2. QR 스캔 — 실제 APK 에 처음 포함.
3. TTL 기준 단위 / BTC 페그 제거분 배포 반영.
4. web·desktop Vite 5 → 8 (pnpm 중첩 의존 해석 때문에 어제 올린 것. 되돌리지 않았다).

크기 차이: 5,596,840 − 5,545,288 = **+51,552 B**.

---

## 6. 빌드 시점 소스 상태

매니페스트 `source`:
- commit 8f8ee530eb8d847e7115551d71df4145a1dce443 (8f8ee53), branch main
- **workingTreeClean = false**
- 경고 "커밋되지 않은 변경이 섞인 빌드다. 이 산출물은 소스로 추적할 수 없다."

이번 라운드 변경 28개 수정 파일(+1,079 / −303 줄) + 신규 파일 8개가 미커밋 상태로 빌드에 들어갔다. 검증기의 "출처" 항목이 SKIP 되는 원인이 이것이다. **커밋 후 재빌드해야 출처 항목이 성립한다.** 이 문서는 그 사실을 그대로 남긴다.

---

## 7. 남은 것

미검증 (했다고 쓰지 않는다):
1. APK 설치·실행. 카메라 QR 스캔 실기기 동작. 계정 이름 편집 런타임 렌더.
2. MSI/NSIS 설치 실행. 데스크톱 번들은 코드서명 설정이 없다.
3. 확장의 브라우저 실제 로드. popup 360px 에서 편집 모드(input + 버튼 2개)가 줄바꿈되는지 — CSS 를 건드리지 않았으므로 좁으면 `.account-kind-badge` 에 flex-wrap 이 필요할 수 있다.
4. eslint 미실행. store.ts 의 `no-control-regex` 억제 주석이 실제로 필요한지 확인하지 않았다.

사람 결정 필요:
1. **커밋 후 재빌드 여부.** 출처 추적을 성립시키려면 지금 변경을 커밋하고 APK 를 다시 만들어야 한다. 그러면 sha256 이 바뀌므로 매니페스트도 다시 기록된다. (커밋·푸시는 지시가 없어 하지 않았다.)
2. docs/CHANGELOG.md 의 기존 `[Unreleased] TTL 이 기준 단위 · QR 스캔` 블록 제목. 그 내용이 0.5.17 로 나가므로 "Unreleased" 는 이제 사실과 다르다. 제목 변경은 지시 범위 밖이라 하지 않았다.
3. 0.5.16 데스크톱 번들 2개(MSI 8,544,256 B / EXE 7,563,423 B)가 같은 폴더에 남아 있다. 삭제 지시가 없어 두었다.
4. 온체인 앵커 부재 — 저장소 통제자가 과거 매니페스트를 바꿀 수 있다는 한계가 그대로 남는다.

---

## 8. 경로

산출물:
- D:/TTLCOINWalet/벼린0.5.17.apk (+ .manifest.json)
- D:/TTLCOINWalet/apps/desktop/src-tauri/target/release/bundle/msi/벼린_0.5.17_x64_ko-KR.msi
- D:/TTLCOINWalet/apps/desktop/src-tauri/target/release/bundle/nsis/벼린_0.5.17_x64-setup.exe
- D:/TTLCOINWalet/apps/extension/.output/chrome-mv3/
- D:/TTLCOINWalet/apps/web/dist/

임시파일: D:/TTLCOINWalet/scripts/rel-out/ — **현재 비어 있다.** 검증용 APK 압축해제 디렉터리 2개(a17·a16)를 만들어 문자열을 센 뒤 삭제했다. 커밋·푸시 없음.
