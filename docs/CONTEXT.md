# 벼린 — 세션 컨텍스트 (Handoff)

> 이 문서의 역할: **새 세션에서 5분 안에 풀 컨텍스트 잡기.**
> 단일 진실원은 [`PLAN.md`](./PLAN.md)지만, "방금 무엇이 어디까지 됐는가"는 이 문서에서 본다.
>
> 마지막 갱신: **2026-08-01** (BTC 이력 3중 트랙 + BIP157 실피어 시험·결함 9건 수정 + 릴리스 파일명 버전화)
> 현재 버전: **v0.5.16 (versionCode 17)** · 릴리스 산출물 = `벼린0.5.16.apk` + `벼린0.5.16.apk.manifest.json`
> GitHub: <https://github.com/okneo31/byeorin> (private)

---

## 0. 30초 요약

- **브랜드 마이그레이션 완료** (노동자의 지갑 → 벼린/Byeorin). 디자인 시스템 v2.
- **Q0 완료, Q1 진입.** SDK + 4종 SW 셸 + HW 사양/펌웨어 스캐폴드 + 보험 v2 + 보안 감사 모두 끝남.
- **2026-05-25 라운드: Extension popup 풀스코프.** 멀티체인 16 슬롯 + 다중 계정 + import/export + ZION 통합. Stage E1(셀렉터·잔액·송금) 완료, E2(주소록·매트릭스 복사)/E3(활동·토큰) 대기.
- **2026-07-25 라운드: 안드로이드 APK 완성.** `apps/android` 신설 — Capacitor 8 + Vite WebView 셸에 Extension popup UI 를 이식. **9 체인 전부 실기기 경로에서 동작 검증** (Pixel 7 Pro 에뮬레이터, release APK). 확장에 없던 계층 추가: 비밀번호 금고 · 자동 잠금 · 뒤로가기.
- **2026-07-26 라운드: 검증 가능한 보안 + 공개 저장소 준비.** 금고를 AndroidKeyStore(TEE/StrongBox) 키로 한 겹 더 감쌈 · 릴리스 매니페스트/검증기 도입 · **재현 빌드가 실측에서 실패**(clean 후 재빌드 시 해시 불일치, [VERIFIABILITY §2.1](./VERIFIABILITY.md)) · 이력 재작성(force push)으로 APK blob 제거 · LICENSE Apache-2.0 + NOTICE + README + SECURITY 추가 · 온체인 앵커 기록기/검증기 구현(**발행 대기**).
- **2026-07-29 라운드: 벼린 환율 + 온체인 앵커 실발행 + Stage E2/E3.** `1 TTL = 노동자 1일 품삯` 을 산식으로 못 박고 통화토큰 66 종 환율을 산출(`docs/RATES.md`) · **BTC 페깅 해제**(2026-07-29 앵커로 한 번 쓰고 끝) · 온체인 릴리스 앵커 **2 건 실제 발행**(0.5.3 / 0.5.4) · 확장·안드로이드에 Stage E2/E3 이식 · TTL 발행 토큰 66 종 자동 감지 · 활동 내역 SDK 경로 수정.
- **2026-08-01 라운드: BTC 이력 3중 트랙 + BIP157 결함 9건 수정.** Electrum · BIP157 라이트클라이언트 · WS 릴레이 3 경로 제작(`15dd271`) → 실피어 통합 시험으로 E2E 성립 확인 + 취약점 4 건을 실패 테스트로 노출(`1c78b20`) → 결함 9 건 전부 수정(`aa25ecc`, 머클루트 검증 · 무한루프 · 큐 상한 · 출금 누락). BIP157 3 스위트 118/118. **이 코드는 아직 어느 셸에도 배선되지 않았다.** 남은 것 5 건은 [`docs/BIP157-FIX-ROUND.md`](./BIP157-FIX-ROUND.md) §6.
- **2026-08-01: 릴리스 파일명이 버전을 포함한다.** `벼린.apk` → **`벼린<versionName>.apk`** (§4 파일 트리 · §릴리스 검증 명령 참조).
- **다음 행동: 실기기 테스트 피드백 반영** → 송금/스왑 브로드캐스트 확인 → 릴리스 전 항목([apps/android/README.md](../apps/android/README.md) 하단). 환율 트랙은 갱신 동력 설계, 검증 트랙은 재현 빌드(§7 D).

### 2026-08-01 라운드 — BTC 이력 3중 트랙 · BIP157 결함 9건 수정 · 릴리스 파일명 버전화

커밋 `15dd271` → `1c78b20` → `aa25ecc`.

| 항목 | 내용 |
|---|---|
| BTC 이력 3중 트랙 (`15dd271`) | Electrum · BIP157 라이트클라이언트 · WS 릴레이. 상세 [`docs/BTC-HISTORY.md`](./BTC-HISTORY.md) |
| 실피어 통합 시험 (`1c78b20`) | E2E 실주소 스캔 성립(피자 tx 10,000 BTC 수취 + 다음 블록 지출까지, SegWit 구간 717 레코드 전량 재확인, 거짓음성 0 — 정답은 블록 원문을 따로 받아 독립 생성해 순환논증 회피). 삼각 검증: BIP158 공식 벡터 = 실 Core 바이트 = SDK 디코더, 8 높이 × 3 피어 일치. 헤더 96만 개 PoW 전량 통과, 89 피어 교차 불일치 0. **취약점 4 건을 실패 테스트로 고정** — 기대값을 구현에 맞추지 않았다 |
| BIP157 결함 9건 수정 (`aa25ecc`) | D1 머클루트 미검증(피어가 내 입금 tx 를 빼면 "이력 없음" 이 되고 예외도 없었다) → `computeMerkleRoot` + 블록마다 대조, 위조 3 종 전부 거부 · D2 헤더 루프 무한 반복(정직한 Core 상대로도 재현) → 무진전 즉시 예외 + 라운드 상한 · D3 메시지 큐 무제한 → 화이트리스트 + 2048통/64MiB(힙 증가 64.6MB → 0.52MiB) · D4 출금 이력 조용한 누락 → 높이 오름차순 스캔 · N1 cfilter 배치 오염 · D5·N2·N3 중경미 3 건. 보고서 [`docs/BIP157-FIX-ROUND.md`](./BIP157-FIX-ROUND.md) |
| 검증 실측 | BIP157 3 스위트 **118/118**, 패키지 전체 685 중 675 통과 · 10 skip · 0 실패, `tsc --noEmit` 무오류. 실피어 5 곳 회귀 전건 일치, 성능 중앙값 −31.6%. 테스트 약화 없음(의도적 실패 4 건 diff 0 줄, skip 0 건) |
| 배선 상태 | **아직 어느 셸에도 배선되지 않았다.** 미수정 5 건은 보고서 §6 |
| **릴리스 파일명 규칙** | `벼린<versionName>.apk` + `벼린<versionName>.apk.manifest.json`. 이름은 `apps/android/android/app/build.gradle` 의 `versionName` 을 읽어 조립한다 — 하드코딩하면 버전을 올릴 때 매니페스트가 가리키는 파일과 실제 배포 파일이 어긋난다. 현재 = `벼린0.5.16.apk` |
| 산출물 버전 | `top.ttl1.byeorin` **v0.5.16 (versionCode 17)** |

### 2026-07-29 라운드 — 벼린 환율 · 온체인 앵커 실발행 · Stage E2/E3

커밋 범위 `91d40b5`…`8a13047` (14개).

| 항목 | 내용 |
|---|---|
| **벼린 환율** (`c9a6771`, `8a13047`) | TTL 이 기준(numeraire)이고 각국 통화토큰이 여기 매달린다. **시장환율을 입력으로 쓰지 않는다** — 산식 어디에도 환율이 들어가지 않는다. `perTtl = 명목GDP(자국통화) / 인구 / 365`, `1 TTL = perTtl 단위의 t{ISO}`. 실제 스냅샷: **66 종 산출 · 미해결 0 건** (`rate-snapshot.json`, `anchoredAt: 2026-07-29` 고정 상수). 예: `1 TTL = 246.65 tUSD = 14,740.71 tJPY = 141,180.04 tKRW = 123.07 tEUR`. 상세·한계는 [`docs/RATES.md`](./RATES.md) |
| 환율 출처 | World Bank `NY.GDP.MKTP.CN`(current LCU) + `SP.POP.TOTL`. **달러 환산 GDP 를 쓰지 않는 이유** = 그 값에 시장환율이 이미 곱해져 있어 배제하려던 것이 뒷문으로 들어온다. **실질 GDP 를 쓰지 않는 이유** = 재려는 것이 바로 그 인플레이션이고, 기준연도가 나라마다 달라 국가 간 비교가 성립하지 않는다. 대만만 World Bank 미수록국이라 IMF DataMapper 에서 `PPPGDP × PPPEX` 항등식으로 자국통화 GDP 를 복원(KOR/JPN/USA/DEU 대조 오차 0.00~0.02%) |
| 합성값 3 종 | `tEUR`(회원국 20 개국 GDP·인구 합산) · `tXOF`(서아프리카 8 개국 합산) · `tTWD`(IMF 유도). `inputs.gdpSynthetic` 필드로 구분된다. 나머지 63 종은 단일 국가 값 |
| **앵커 2 개, 서로 만나지 않는다** | ① BTC **63,412.45 @ 2026-07-29 00:00 KST** → TTL 외부 시세. **이후 페깅 해제** — 스냅샷 어디에도 BTC 도 달러 시세도 없다(테스트가 이를 지킨다). ② 2025 명목GDP/인구 → 66 종 환율. 이후 외부 데이터를 보지 않는다. `crossRate(from,to) = to.perTtl / from.perTtl` 이라 TTL 의 절대 눈금은 약분된다 |
| 지갑 환율 조회 | **주소로 찾는다, 심볼이 아니라.** 심볼 키였을 때 `tUSD` → `TUSD`(이더리움 TrueUSD)와 충돌해 TrueUSD 잔액에 벼린 환율이 붙는 버그가 실제로 있었다. 환율을 모르면 `null`, `0` 이 아니다 — 화면은 **가치 자리를 비우고 수량만** 보여준다 |
| 토큰 목록 화면 | `TokenListPane` — 66 종 검색 · 개별 보기/가리기 · TTL 환산 가치 · 환율 근거 패널(GDP·인구·연도·ISO3·합성 여부). 가리기는 **가린 목록만 저장**(allowlist 아님 — allowlist 면 새로 발행된 토큰이 영영 안 보인다). **커밋 기준(`8a13047`)으로는 확장에만 있다** — 안드로이드에는 CSS(149줄)만 들어갔다. (본 문서 갱신 시점의 작업 트리에는 안드로이드 `screens/TokenListPane.tsx` · `lib/token-visibility.ts` 이식이 **미커밋 상태로 진행 중**이며 `App.tsx` 에 배선까지 돼 있다. 동작 검증 여부는 **미확인**) |
| **온체인 앵커 실발행 2 건** | 0.5.3 (4) — tx `0xbaa318f2…01c1`, block **1125713**, sha256 `3c545e15…eeb1`, 출처 `560e39e`. 0.5.4 (5) — tx `0xca7039ea…59fd`, block **1126124**, sha256 `bf2436b1…82ce`, 출처 `b44bc80`. publisher `0x52B5dE96dC298f98a0cDf9E694De1Cc55c28f533` (ChainID 7777). `anchor-publishers.json` 의 `publishers` 가 채워졌다. 가스 실측 27,224 × 50 gwei = **0.0013612 TTL/건** |
| 앵커의 append-only 대가 | 0.5.3 앵커는 **번역이 깨진 빌드**(낡은 i18n dist)를 가리킨다. 지울 수 없어서 0.5.4 로 새 앵커를 올려 덮어 설명했다. 두 앵커 모두 체인에 영구히 남는다 |
| 검증기 정직성 수정 (`30f5e85`) | 음성 테스트 12 건으로 찾은 것: **`publishers` 가 빈 배열일 때 아무 주소로 만든 tx 나 `[OK]` 로 통과**했다(경고도 없었음 — 당시 라이브 상태) · chainId 미검사 → `eth_chainId` 대조 · pending tx 가 OK → SKIP+경고. 기준을 "확실히 틀린 것은 FAIL, 확인할 수 없는 것은 SKIP" 으로 정리. 기록기에도 전송 전 chainId·주소·잔액 3중 사전검사 추가 |
| 검증기 종료코드 버그 (`be1e56f`) | 화면엔 ✅ 인데 exit 127. `process.exit()` 를 앵커 fetch 직후 호출해 Windows libuv assertion 이 터지고 종료코드가 덮였다. `process.exitCode` 방식으로 교체. 정상 exit 0 / sha256 조작 exit 1 / 없는 txHash exit 1 양쪽 확인 |
| publisher 키 파생 (`8005923`, `cdd2197`) | `scripts/derive-publisher-key.mjs` + `scripts/Set-AnchorKey.ps1`. 시드구문은 **stdin 으로만** 받는다(argv 는 프로세스 목록·셸 히스토리에 남는다). PS 5.1 의 `$OutputEncoding` 기본값이 ASCII 라 **한국어 시드가 통째로 `?` 로 파손**되던 것을 base64 래핑으로 해결. `anchor-publishers.json` 이 닫는 중괄호 뒤 `ro` 두 글자 때문에 JSON 파싱 자체가 안 되던 것도 수정 |
| Stage E2/E3 (`606a218` 확장, `560e39e` 안드로이드) | 체인별 주소 매트릭스 · 주소록(self 자동 sync + 외부 CRUD + 송금 자동완성) · 활동 내역 · 토큰 송금. popup `App.tsx` 2585 줄을 `screens/` 로 분할. 안드로이드는 확장의 **별도 복사본**이라 자동으로 따라오지 않아 수동 이식 — 달라진 것은 import 경로 · 주소록 저장 백엔드(Chrome ↔ localStorage) · 입력 `className="input"` 셋뿐 |
| 활동 내역 SDK 수정 (`dabbdab`) | TTL Scan 이 etherscan 호환이라 **가정**하고 있었으나 실측하니 아니다(자체 규격, `/api` catch-all 없음 → 항상 404 → 항상 fallback). 진짜 경로 `/api/indexer/address/:addr/txs` 를 1순위로. `rawGetLogs` 가 viem `client.getLogs` 를 먼저 시도해 41.1 초 매달리던 것을 `client.request` 직접 호출로 교체. 실측: 거래 있는 주소 **0 건 / 13.8 초 → 20 건 / 1.39 초**, 없는 주소 13.8 초 → 0.41 초 |
| TTL 토큰 66 종 자동 감지 (`b44bc80`) | 레지스트리 `BUILTIN` 의 TTL(7777) 항목이 **0 개**였다 — 사용자가 주소를 손으로 넣지 않으면 아무것도 안 보였다. `tokens/ttlscan.ts` 가 `/api/tokens` 를 읽어 registry 에 얹는다. 신뢰 경계: 이 목록은 **무엇을 조회할지만** 정하고 잔액은 반드시 체인 `balanceOf` 로 읽는다. `discoverEvmTokens` 의 `maxRpcCalls` 50 → 256(50 이면 66 종을 조용히 잘라냈다). 실측: 목록 66 개 872ms · balanceOf 66 건 694ms |
| 빌드 순서 버그 (`b44bc80`) | 실기기 화면에 버튼이 `addresses.title` 로 떴다. 앱만 빌드하고 `@byeorin/i18n` 등 워크스페이스 의존성을 빌드하지 않아 **낡은 dist 가 APK 에 실렸다**. typecheck 도 test 도 못 잡는다(`t()` 는 없는 키도 타입 오류가 아니다). 빌드 스크립트 앞에 `pnpm -r --filter <pkg>^... build` 를 붙여 막았다 |
| Solana RPC fallback (`91d40b5`) | 백로그 #26. **읽기만** publicnode → OnFinality → dRPC 로 넘어가고 쓰기는 단일 고정(A 에서 받은 blockhash 를 B 로 보내면 tx 가 깨진다). 그 구분을 주석이 아니라 자료구조로 강제(`readEndpoints` / `writeConnection` 별개 필드). **실측(2026-07-28): 2·3순위는 무키 상태에서 각각 429/400 을 돌려준다 — 지금은 실질 이중화가 아니다** |
| 산출물 | `top.ttl1.byeorin` **v0.5.4 (versionCode 5)** · APK 5,261,688 B · sha256 `bf2436b1…82ce` · 매니페스트 출처 커밋 `b44bc80` (main, `workingTreeClean: true`) · 앵커 `0xca7039ea…59fd` |
| 검증 (본 문서 갱신 시 재실행) | `pnpm test` **450 통과 / 9 skipped** (i18n 19 · wallet-sdk 266 · shell-core 52 · extension 113). `pnpm typecheck` 9 워크스페이스 통과 |

### 2026-07-26 라운드 — 검증 가능한 보안

| 항목 | 내용 |
|---|---|
| 금고 하드웨어 바인딩 | `시드 → AES-GCM(scrypt(비밀번호)) → AES-GCM(AndroidKeyStore 키) → localStorage`. 바깥 겹의 키는 TEE/StrongBox 안에서 생성돼 칩 밖으로 나오지 않음 → 저장 파일만 떠가는 **오프라인 대입 경로 제거**. 하드웨어 계층이 뚫려도 남는 것은 scrypt 로 잠긴 blob. 신규 `VaultCryptoPlugin.java`(로컬 Capacitor 플러그인, 서드파티 의존성 0) + `src/vault-hw.ts`(`PersistentBackend` 래퍼) — **shell-core 변경 0줄**. 하드웨어를 못 쓰면 보호 수준을 낮춰 저장하지 않고 실패. `setUserAuthenticationRequired` 는 켜지 않음(생체 재등록·화면잠금 변경 시 키 무효화 사고). 에뮬레이터 실측: 옛 금고 `{"v":1,"kdf":"scrypt","N":65536,…}` → 새 빌드에서 `{"hw":1,"iv":…,"ct":…}` 자동 승급, 계정 `0xf39F…2266` 복원. `isAvailable → {available:true, strongBox:false}` (에뮬레이터는 TEE 폴백) |
| 릴리스 매니페스트 | `apps/android/scripts/release-manifest.mjs` — release 빌드 때 `gradle.mjs` 가 자동 생성. 담기는 값: 파일 SHA-256 · 서명 인증서 지문 · 출처 커밋/브랜치 · **작업 트리 청결 여부** · 툴체인 버전 · **주장하지 않는 것**(`claims.notClaimed`) |
| 제3자 검증기 | `scripts/verify-byeorin-apk.mjs` — 의존성 0(순수 fetch). 무결성(SHA-256) / 진위(서명 인증서) / 출처(주장) / 온체인 앵커 4항목. 우리 서버에 아무것도 묻지 않음 |
| 공개 서명 인증서 지문 | `303f801bb44af8c494b6e89844fbe86c36bd6f48ab404a4b6c0228fa3f103480` |
| **재현 빌드 = 안 됨 (실측)** | 추측이 아니라 측정 결과. 증분 빌드 직후 `cd3fcb6d…75b67` / `gradlew clean` 후 재빌드 `5363e843…002dc`. **같은 머신·같은 커밋·같은 툴체인인데 바이트가 다르다.** 앞선 커밋(`08e954b`)에서 해시가 같게 나온 것은 Gradle 이 산출물 130 태스크를 up-to-date 로 재사용한 증분 빌드였고 결정성의 근거가 아니었다 — 그렇게 서술했던 것을 `2316a0c` 에서 정정. 따라서 매니페스트의 `commit` 이 그 바이트를 만들었다는 **증명은 없고 현재는 주장이다** |
| 매니페스트 정직성 버그 2건 | ① `벼린.apk` 가 git 에 추적 중이라 빌드마다 "작업 트리 더러움" 이 상시 켜져 있었음 — `.gitignore` 규칙을 이미 추적된 파일 뒤에 넣어 효력이 없었다. `git rm --cached` 로 해제. ② 더러움 판정에서 산출물 자신(매니페스트)을 제외 — 빼지 않으면 "매니페스트를 쓰는 행위가 트리를 더럽혀 다음 매니페스트가 더럽다고 말하는" 자기참조. git 호출에 `core.quotepath=false` (한글 경로 8진 이스케이프 방지) |
| 이력 재작성 | 5MB APK blob 3개를 이력에서 제거 (force push). `.git` 42MB → 21MB, 커밋 39 = 39 · 파일 455 = 455 · 트리 diff 없음(소스 유실 없음). 커밋 SHA 가 전부 바뀌어 매니페스트를 새 HEAD 기준으로 재생성 |
| 공개 저장소 준비 | `LICENSE`(Apache-2.0 원문, apache.org 에서 수령) · `NOTICE`(창작재산권 okneo31 + 상표 조항 + 제3자 구성요소) · `README.md`(원칙 · APK 검증법 · 지원 체인 · 금고 구조 · 못 하는 것 포함 상태표) · `SECURITY.md`(신고 절차, in scope / 문서화된 설계 한계) |
| 온체인 앵커 (**발행 대기**) | `scripts/anchor-release.mjs` 기록기 + 검증기 확장. **컨트랙트 없음** — 0-value 트랜잭션 `data` 에 사람이 읽는 텍스트 한 줄 `byeorin:release:1\|sha256=<64hex>\|v=<name>+<code>\|commit=<40hex>`. 검증은 `eth_getTransactionByHash` 1회(O(1)). append-only(수정·폐기 기능 없음). 커밋 안 된 변경이 섞인 빌드는 기록기가 거부. publisher 단일 키로 시작(약점 명시). 드라이런만 확인, **실제 앵커 트랜잭션은 미발행** — `anchor-publishers.json` 의 `publishers` 는 현재 빈 배열 |
| 산출물 | `top.ttl1.byeorin` **v0.5.2 (versionCode 3)** · APK 5,221,596 B · sha256 `5363e843…002dc` · 매니페스트 출처 커밋 `b33ebf3` (main, workingTreeClean=true) |

### 2026-07-25 라운드 — 안드로이드

| 항목 | 내용 |
|---|---|
| 셸 방식 | **Capacitor 8 + Vite WebView.** RN 0.76 Bare 는 Hermes 에 WASM 이 없어 BTC/SOL/TRON 어댑터가 원천 불가 — 9 체인 요구를 만족하는 유일한 경로가 WebView 였다. `apps/mobile` (RN 스캐폴드) 은 그대로 보존. |
| 코드 재사용 | 확장 popup `App.tsx` 2543 줄을 거의 그대로 이식. HW(WebHID)/연결된 사이트(EIP-1193) 만 제거 — 플랫폼에 해당 기능 자체가 없음. |
| 신규 모듈 | `keystore-session.ts` (비밀번호 금고: 오입력 보호 · 디바운스 저장 · clear=잠금/wipe=폐기), `native-http.ts` (ZION AMM 만 CORS 우회), `autolock.ts` (백그라운드 2분), `back-button.ts` |
| CORS 실측 | 9 체인 RPC 중 `api.zion1.top` 만 ACAO 없음 → 그 하나만 네이티브 HTTP. 전역 `CapacitorHttp` 패치는 viem 과 충돌 우려로 배제. |
| 산출물 | `top.ttl1.byeorin` v0.5.0 · release APK 5.0MB (RSA-4096 서명) · debug 6.4MB |
| 잡은 버그 | 런치 테마 `android:background` 가 모든 View 기본 배경으로 상속 → `<select>` 드롭다운 16 행에 스플래시 이미지가 깔림. `android:windowBackground` + core-splashscreen 속성으로 교체. |
| i18n | `vault.*` 24 키 신규 (ko/en). `footer.skeleton` 의 "v0.1 skeleton" 문구 제거. |

### 2026-05-25 라운드 변경 요약 (v0.5 → 작업분)

### 본 라운드 변경 요약 (v0.5 → 작업분)

| 영역 | 변경 |
|---|---|
| `wallet-sdk` | `accountFromPrivateKey` · `transferAccount` 자유함수 · `privateKeyToHex` · `getWordlist`. **새 subpath `@byeorin/wallet-sdk/multichain`** — `ChainSpec` + `DEFAULT_CHAINS` 16종 (EVM 8 + BTC/XRP/SOL/TRON/TON/Aptos/Sui + **ZION**). `ZION_CHAIN_SPEC` + `cosmosChainSpec()` factory. ChainSpec 에 `nativeSymbol`·`nativeDecimals` 메타. ZION 어댑터 호환성 검증 8 tests (defaultFee=0n). private-key 12 tests. |
| `shell-core` | `WalletStore` 다중 계정 매니저 — `addMnemonicAccount/importPrivateKey/selectAccount/listAccounts/removeAccount/exportMnemonic/exportPrivateKey/getActiveIndex/getAccountAt(idx, adapter)`. 세션 직렬화 v2 (JSON), v1 mnemonic-only 자동 마이그레이션. 옛 `unlock(mnemonic)` 시그니처 보존 → Web/Desktop/Mobile 셸 영향 0. 새 `Addressbook` 모듈 (self 자동 sync + external CRUD). 다중계정 15 tests 신규. |
| `apps/extension` | popup 풀 재작성: 16 체인 셀렉터, 다중 계정 셀렉터, 활성 계정 카드(잔액 hero + BTC/USD 토글 + 주소 복사 + QR), 송금 화면, import PK pane, export secret pane, 시드 생성 3단계(언어→표시→검증) + NFKD 정규화 + datalist 자동완성. `qrcode` 의존성. **Buffer polyfill** (`popup/main.tsx`) — cosmos/solana 등 라이브러리 호환. **MV3 CSP `'wasm-unsafe-eval'`** — @solana/web3.js WASM. Binance ticker 시세 1회 fetch. |
| `apps/{web,desktop,mobile}` | **변경 없음.** 옛 단일 계정 흐름 그대로. Stage W/D/M 에서 Extension reference 복제 예정. |
| docs/memory | ZION 메모리 신규 (`project_zion_chain` + `reference_zion_wallet_doc`). 본 문서 갱신. |

### 본 라운드 미완 / 대기

| Task | 상태 | 내용 |
|---|---|---|
| #20 Stage E2 | **완료 (2026-07-29)** | 계정 카드의 9 체인 주소 row + 원클릭 복사, 주소록 화면(자동 sync + 외부 추가), 송금 시 주소록 추천 |
| #20 Stage E3 | **완료 (2026-07-29)** | 활동 내역(Activity) + ERC-20 토큰 목록 + 토큰 송금 분기 |
| #26 | **완료 (2026-07-29)** | SolanaAdapter — 멀티 RPC fallback (read-only): publicnode → OnFinality → dRPC. 송금은 단일 (`recent_blockhash` 일관성). 단, 2·3순위가 무키 상태에서 429/400 이라 실질 이중화는 아직 아니다 |
| #13/14/15 Stage W/D/M | Extension 완성 후 | Web/Desktop/Mobile 셸을 Extension reference 패턴으로. Mobile 만 RN 재작성, Web/Desktop 은 거의 복붙 |
| #16 | Stage B 묶음 | extension e2e smoke 확장, 위협모델 갱신, CONTEXT/PLAN closed 처리 |
| #23/24/25 Z2/Z3/Z4 | 별도 트랙 | ZION 커스텀 메시지(job/amm/pop/bankext/poms) + 기능 UI(잡마켓·AMM·PoP·BTC브릿지) + zion-api 연동 |
| #27 TTL 가치표시 | 완료 | **1 TTL = 노동자 하루 품삯(데나리온)**. 환산은 설계자 연봉 1000 BTC ÷ 365일 = 설계자의 하루 = 100 TTL → 1 TTL = 10/365 ≈ 0.02739726 BTC (2026-07-25 개정, 이전 1/300,000). kWR 은 따라가지 않고 1/300,000 별도 트랙<br>**→ 2026-07-29 정정: BTC 페깅 해제.** 이 비율은 2026-07-29 앵커에 한 번 쓰이고 끝났다. 현행 기준은 §5 "벼린 환율" |

### 본 라운드 외부 결정 (사용자 확정)

- **멀티체인 = 9 어댑터 풀스코프** (PLAN §2.4 전체). Cosmos 슬롯 = **ZION 단독** (외부 Cosmos Hub/Osmosis 등은 후속 추가).
- **풀 ZION 기능** 목표 (job/amm/pop/BTC브릿지) — 별도 트랙 Z2~Z4.
- **원클릭 주소 복사** = 각 체인 row 옆에 (체인당 1개씩) — Stage E2 에서 구현.
- **주소록** = self 자동 sync — `shell-core/Addressbook` 모듈 완성. UI 는 E2.
- **가치 표시** = native 잔액 메인 + BTC 환산 보조 (클릭하면 USD 토글). 천 단위 쉼표. 시세 = Binance ticker. TTL 페그 = 10/365 BTC (노동가치 기준). — **2026-07-29 정정: 페깅 해제** (§5).
- **MV3 popup 멀티체인 인프라** = WASM CSP `'wasm-unsafe-eval'` 허용 + Buffer polyfill 필수. multichain 청크는 dynamic import 로 분리 (popup 초기 78kB, multichain 5.76MB lazy).
- **RPC override** = `ethereum`/`solana` 만 publicnode 로 override (viem default 와 mainnet-beta 가 extension origin 거부 또는 hang). 나머지 EVM/비-EVM 은 라이브러리 기본 RPC.

---

## 1. 정체성 (변경 금지 / 단일 진실원)

| 항목 | 값 | 비고 |
|---|---|---|
| 마스터 브랜드 | **벼린** (Byeorin) | 단조(벼리다) + 핵심(벼리) 이중의미 |
| 포지션 슬로건 | "노동자의 지갑" (Worker's Wallet) | 정식명 아님, 부제·헤더 카피 |
| 슬로건 | "노동자의 지갑이 세상을 자유롭게" | 마이그레이션 시 placeholder 보호 |
| HW 디바이스명 | **벼린 요세** (Byeorin Yose) | 요세=요새(要塞), 시드 보관 거점 |
| 패키지 scope | `@byeorin/*` (5 packages) | 마이그레이션 완료 |
| 루트 package | `byeorin-wallet` | |
| 펌웨어 보드 | `nrf52840_byeorin_yose` | overlay 파일도 rename됨 |

### 컬러 팔레트 (v2)

| 토큰 | HEX | 용도 |
|---|---|---|
| `--nd-red` / `--nd-ember` | `#E84D1A` | 잉걸 오렌지 — primary action |
| `--nd-ink` / `--nd-anvil` | `#1A1A1A` | 모루 차콜 — 본문/로고 |
| `--nd-black` / `--nd-night` | `#0B0B0D` | 밤 모루 — 다크모드 배경 |
| `--nd-steel` | `#9CA3AF` | 강철 실버 — 보더/비활성 |
| `--nd-sweat` | `#2E78D2` | 땀 블루 — 정보/링크 |
| `--nd-paper` | `#FAFAF7` | 종이 화이트 — 라이트 배경 |
| `--nd-yellow` | `#F4C430` | 따뜻한 강조 (유지) |

> `--nd-*` prefix는 호환성 위해 유지. 새 코드는 의미적 alias(`--nd-ember`/`anvil`/`night`/`steel`/`sweat`) 사용 권장.

---

## 2. 자산 인벤토리

### 디자인 자산 (`D:\TTLCOINWalet\`)
| 파일 | 용도 |
|---|---|
| `logo0.png` (4MB, 2048×2048) | 마스터 심볼 (모루+불꽃) |
| `logo0.svg` (956KB, 벡터) | 마스터 심볼 벡터 버전 |
| `logo0_dark.png` | 다크모드 자동 변환 (HLS 명도 반전) |
| `lockup가로.png` | Lockup B (심볼+워드마크 가로) |
| `lockup세로.png` | Lockup A (심볼+워드마크 세로) |
| `벼린 워드마크.png` | 한글 워드마크 단독 (메탈릭 음각) |
| `BYEORINWordMark.png` | 영문 워드마크 (스텐실 세리프) |

### 앱 아이콘 패키지 (`icons/dist/`)

64 파일 — iOS/Android/Web/PWA/Win/macOS/Social 일괄. 자세한 폴더 구조는 [`icons/dist/README.md`](../icons/dist/README.md).

각 앱에 배포 완료된 상태 (deploy_icons.py, 17 타겟):
- `apps/web/public/` — favicon{,.ico,.png}, apple-touch, og.{png,jpg}, manifest.webmanifest
- `apps/extension/public/icon/` — 16/32/48/128
- `apps/desktop/src-tauri/icons/` — Tauri 5 파일 + `icon.iconset/` (macOS .icns 입력)
- `apps/mobile/assets/AppIcon.appiconset/` + `android-icons/` — RN bare workflow

### 옛 자산 (아카이브 후보)
- `branding/raw/*.svg` — 옛 곡괭이 컨셉 (Concept A/B/C, og.svg, mark.svg, logo-wordmark.svg)
- `verification/icon-concepts/*.svg` — 옛 아이콘 컨셉
- 텍스트는 마이그레이션됐지만 그래픽은 옛것. **삭제 또는 아카이브 결정 미정**.

---

## 3. 스크립트 인벤토리 (`scripts/`)

브랜드/디자인 자동화 5종:

| 스크립트 | 용도 |
|---|---|
| `make_dark_mode.py` | logo0.png → logo0_dark.png. HLS 명도 반전 + 좌표 마스킹 |
| `downsample_test.py` | 다양한 사이즈(16~512px) 다운샘플 테스트 |
| `generate_all_icons.py` | 전 플랫폼 자산 일괄 생성 (64파일 → `icons/dist/`) |
| `deploy_icons.py` | `icons/dist/` → 각 앱 적절한 위치로 (17 타겟) |
| `migrate_brand.py` | 브랜드 텍스트 일괄 치환 (dry-run/--apply, 슬로건 보호) |

릴리스 검증 4종 (2026-07-26 신설, 2026-07-29 확장):

| 스크립트 | 용도 |
|---|---|
| `verify-byeorin-apk.mjs` | **제3자용 검증기.** 의존성 0(순수 fetch). 무결성/진위/출처/온체인 앵커 4항목 대조. 확실히 틀린 것은 FAIL, 확인할 수 없는 것은 SKIP |
| `anchor-release.mjs` | 릴리스 매니페스트 해시를 TTL 체인(7777)에 앵커링. 기본 드라이런, `--send` + `BYEORIN_ANCHOR_KEY` 로 발행. 전송 전 chainId·publisher 주소·잔액 3중 사전검사 |
| `derive-publisher-key.mjs` | 시드구문 → 앵커 publisher 개인키 파생 (2026-07-29 신설). 시드는 **stdin 으로만** 받고 argv·파일에 남기지 않는다. `--stdin-base64` 로 UTF-8 시드를 base64 로 감싸 받는다. 지갑과 같은 SDK 코드 경로를 쓰고, 두 경로로 구한 주소가 어긋나면 키를 출력하지 않고 죽는다 |
| `Set-AnchorKey.ps1` | 위 스크립트의 PowerShell 래퍼 (2026-07-29 신설). 시드를 `Read-Host -AsSecureString` 으로 받아 `BYEORIN_ANCHOR_KEY` 환경변수에 넣는다. `-Persist` 는 HKCU 레지스트리에 **평문**으로 남는다(스크립트 내 "노출 범위" 참고). `-Clear` 로 삭제 |

> 매니페스트 생성기는 안드로이드 앱 쪽에 있다 — `apps/android/scripts/release-manifest.mjs` (release 빌드 시 `gradle.mjs` 가 자동 호출).

환율 1종 (2026-07-29 신설):

| 스크립트 | 용도 |
|---|---|
| `build-rate-snapshot.mjs` | 벼린 환율 스냅샷 생성기 (재현용). World Bank API + IMF DataMapper + TTL Scan 토큰 목록을 읽어 `rate-snapshot.json` 과 `packages/wallet-sdk/src/rates/snapshot.ts` 를 **한 번에** 만든다. 검증 목적이면 `--out` 으로 다른 경로를 줘야 저장소 사본을 덮지 않는다 — 단 `snapshot.ts` 는 `--out` 을 줘도 항상 제자리에 덮어쓰므로, 검증 후 `git diff` 로 변화가 없는지 확인한다 |

기존 코어 도구 (참고):
- `setup-check.mjs`, `verify-addresses.mjs`, `devnet-round-trip.mjs`, `generate-extension-icons.mjs`

---

## 4. 모노레포 구조

```
D:\TTLCOINWalet\
├── apps/
│   ├── android/     ★ Capacitor 8 + Vite WebView → APK. 9 체인 전부 동작 (실사용 셸)
│   ├── mobile/      RN 0.76 Bare TS — 네이티브 프로젝트 없음. android/ 로 대체됨(보존)
│   ├── web/         Vite + React
│   ├── desktop/     Tauri 2 (src-tauri 포함)
│   └── extension/   WXT (MV3)
├── packages/
│   ├── wallet-sdk/  코어 SDK (9 체인 어댑터: EVM/BTC/XRP/Cosmos/Sol/Tron/TON/Aptos/Sui)
│   ├── shell-core/  WalletStore + SessionStore + Keystore (scrypt N=2^17 + AES-256-GCM)
│   ├── design-system/  토큰 + Logo/Button/Card/Input/AddressDisplay/AmountDisplay
│   └── i18n/        한/영 (일/중은 2차)
├── firmware/
│   └── app/         Zephyr RTOS, nRF52840 + SE050 + e-ink. 컴파일 통과, HW-터치는 -ENOSYS stub
├── hardware/        SPEC.md, BOM.csv, pin-map.md, threat-model.md
├── verification/    10/10 cross-SDK 주소 검증 + test-dapp.html
├── docs/            PLAN.md(v0.5), ARCHITECTURE.md, VERIFIABILITY.md, RATES.md, CHANGELOG.md, INSURANCE.md, CONTEXT.md(본문)
├── icons/dist/      64 파일 앱 아이콘 패키지
├── scripts/         자동화 (위 §3)
├── branding/raw/    옛 곡괭이 자산 (정리 후보)
├── LICENSE, NOTICE, README.md, SECURITY.md   공개 저장소 세트 (2026-07-26)
├── anchor-publishers.json   앵커 publisher 허용 목록 (chainId 7777, 단일 키 0x52B5dE96…f533)
├── rate-snapshot.json       벼린 환율 스냅샷 (66종, anchoredAt 2026-07-29) — 사람이 검증하는 사본
├── 벼린<versionName>.apk (git 미추적) + 벼린<versionName>.apk.manifest.json (추적 — 공개 검증 근거)
│                            현재 = 벼린0.5.16.apk / 벼린0.5.16.apk.manifest.json (이름은 build.gradle 의 versionName 에서 조립)
├── BYEORINWordMark.png, lockup{가로,세로}.png, 벼린 워드마크.png, logo0.{png,svg,_dark.png}
└── package.json (byeorin-wallet, pnpm workspace)
```

---

## 5. 닫힌 결정 (재논의 X)

- **BTC 페깅 해제** (2026-07-29). 옛 결정 "TTL = 10/365 BTC"(2026-07-25, `a4b4a03`)는
  **2026-07-29 앵커로 한 번 쓰고 해제됐다.** BTC 63,412.45 @ 2026-07-29 00:00 KST 를
  TTL 의 초기 외부 시세를 정하는 데 한 번 쓴 뒤, 그 이후로는 TTL 을 BTC 에 매달지
  않는다. 이 값은 `rate-snapshot.json` 어디에도 들어 있지 않고, 테스트가 "BTC 앵커는
  이 스냅샷 어디에도 등장하지 않는다" 로 그 분리를 지킨다. §0 옛 라운드 표와 메모리
  (`project_token_pegs`)에 남아 있는 "TTL 페그 = 10/365 BTC" 서술은 이 결정 이전의
  기록이다.
  > **코드가 따라왔다 (2026-08-02, 닫힘).** 0.5.4~0.5.16 까지 두 셸의 `App.tsx` 는
  > `TTL_PEG_BTC = 1000/365/100 = 10/365` 를 들고 잔액 화면의 TTL 가치를 이 비율 ×
  > Binance 실시간 BTC 시세로 계산했다. 그 경로를 제거했다 — `TTL_PEG_BTC` ·
  > `KWR_PEG_BTC` · `PRICE_PEG_TO_BTC` · `TTL_ANCHOR_BTC` · `nativeToTtl` ·
  > `usdToTtl` · `nativeToBtcRatio` · `nativeToBtc` 를 두 파일에서 지웠고,
  > `tokenToUsd` 안의 `peg × btcUsd` 분기 자리는 `return null` 이다. 저장소 전체
  > grep 에서 이 이름들의 코드 잔재는 0 건이다.
  > 대신 화면은 **환산하지 않는다** — TTL 잔액 옆에는 그 정의(`노동자 {v} 일 품삯`,
  > `tokens.value_labor_days`)가 곱셈 0 회로 그대로 온다. 외부 상장자산(BTC·ETH·SOL…)
  > 만 Binance 트랙에서 USD 로 재고, 두 트랙을 잇는 코드는 남기지 않았다.
  > 두 앵커가 7 배 어긋나 보이던 문제(`63,412.45 × 10/365 ≈ 1,737 USD/TTL` 대
  > `1 TTL = 246.65 tUSD`, 커밋 `c9a6771`)는 **비교 자체가 사라져** 해소됐다.
- **벼린 환율 = TTL 이 기준, 시장환율을 입력으로 쓰지 않는다** (2026-07-29).
  `1 TTL = 노동자 1일 품삯. 국적과 무관하다.` 산식은 `perTtl = 명목GDP(자국통화) /
  인구 / 365` 하나뿐이고 어디에도 환율이 들어가지 않는다. 명목 GDP 를 쓰는 이유는
  재려는 것이 인플레이션 자체이기 때문이고, 자국통화 단위를 쓰는 이유는 달러 환산
  GDP 에 이미 시장환율이 곱해져 있기 때문이다. `t{ISO}` 토큰은 **실제 그 나라 통화가
  아니다** — 상환·예치·페그 어느 것도 없다. 앵커 2 개(BTC → TTL 외부 시세 /
  GDP·인구 → 통화토큰 환율)는 별개 트랙이고 만나지 않는다.
  전문·한계는 [`docs/RATES.md`](./RATES.md).
- **라이선스 = 전체 Apache-2.0** (2026-07-26). 창작재산권은 okneo31, NOTICE 표기
  의무(§4(d))로 파생물에도 표기가 따라간다. "벼린"·"Byeorin"·"벼린 요세" 상표는
  라이선스 대상이 아니다(§6) — 포크는 다른 이름을 써야 한다. 자체 라이선스를
  쓰지 않은 이유: SPDX/GitHub/npm/기업 스캐너가 인식 못 하면 `unknown license` 로
  차단된다. 파일: [`LICENSE`](../LICENSE), [`NOTICE`](../NOTICE).
- **검증 가능한 보안** (2026-07-25) — "규칙은 누구나 검증 가능하게, 권한은 아무나가
  아니게". 목표는 "최고의 보안"이 아니라 확인 가능한 보안. 규칙을 이해 못 하게 만드는
  방향(난독화)은 채택하지 않는다 — 감사 불가능한 규칙은 중앙 권위를 재발명한다.
  절차와 로드맵은 [`docs/VERIFIABILITY.md`](./VERIFIABILITY.md), 요세 요구사항은
  SPEC F-11~F-14.
- 마스터 브랜드 = 벼린 (2026-05-17)
- HW 디바이스명 = 벼린 요세 (2026-05-18)
- 워드마크 폰트 = 굵은 산세리프 (Pretendard Black 계열). 명조 X
- 로고 컨셉 = 모루 + 불꽃 (단조의 순간)
- 컬러 팔레트 = 잉걸 오렌지/모루 차콜/강철 실버/땀 블루/종이 화이트/밤 모루
- 패키지 scope = `@byeorin/*`
- design-system CSS 변수 prefix = `--nd-` 유지 (의미: 노동의 디자인)
- Expo Managed 거부 → RN 0.76 Bare (2026-05, 스캐폴드만)
- **모바일 셸 = Capacitor 8 + WebView** (2026-07-25). RN 유지 시 Hermes 에 WASM 이 없어
  BTC/SOL/TRON 어댑터가 원천 불가 → "9 체인 전부" 요구와 양립하지 않는다. `apps/mobile`
  RN 스캐폴드는 지우지 않고 보존 (USB-OTG HW 서명 등 네이티브 요구가 생기면 재사용).
- Electron 거부 → Tauri 2
- 확장 raw MV3 거부 → WXT

## 6. 열린 결정 ([PLAN.md §10](./PLAN.md))

- TTL coin_type SLIP-0044 신청? (현재 60 공유)
- HW 1차 시판 국가 (한국 단독? 한+미+EU?)
- 시드 백업 정책 (종이 + Shamir + 클라우드 보조?)
- 요세 펌웨어를 공개·재현 가능하게 낼지 ([SPEC F-11](../hardware/SPEC.md), [VERIFIABILITY §2](./VERIFIABILITY.md) 에 "미결정"으로 기재)

> 라이선스 항목은 2026-07-26 에 닫혔다 → §5.

---

## 7. 다음 작업 후보 (우선순위)

### A. PLAN.md §9 "즉시 다음 행동" — Q1 본격 실행
1. **Web TTL claim 페이지** 외부 사용자 테스트 (피드백 루프)
2. **Extension EIP-1193** WalletConnect v2 (Reown) 외부 dApp 1개 연동
3. **Cross-shell 영구 keystore** 마이그레이션 (web in-memory → opt-in localStorage)
4. **SignerRouter** 인터페이스 정의 (HwSigner 실제는 Q4)

### B. 정리/위생 작업
- 옛 곡괭이 자산 (`branding/raw/`, `verification/icon-concepts/`) 삭제/아카이브 결정
- 옛 커밋 author 정리 — 현재 41 커밋 중 **19개**가 `*@nodong.local` 봇 author
  (`c4213e8` = design-pickaxe 등). 2026-07-26 이력 재작성 때는 author 를 건드리지
  않아 그대로 남아 있다. history rewrite + force push 필요.
- Mobile/Android RN bare 빌드에 새 아이콘 wire up

### C. HW Q4 진입 사전작업
- SE050 vs ST31N600 최종 결정 (lead time 견적)
- KiCad EVT-1 스키매틱 캡쳐 시작 (`hardware/kicad/`)
- USB-IF VID 신청

### D. 검증 체계 ([VERIFIABILITY.md §3](./VERIFIABILITY.md) 로드맵)

> 로드맵 1순위 "온체인 릴리스 앵커 실제 발행" 은 2026-07-29 에 **완료**됐다
> (0.5.3 / 0.5.4 두 건, §0 표). 아래는 그 다음.

1. **재현 빌드** (현 1순위) — 여전히 **안 됨**(2026-07-26 실측, §0 표). `SOURCE_DATE_EPOCH`
   로 zip 타임스탬프 고정, AGP/Gradle/JDK 핀 고정, 컨테이너 빌드. 서명 전 APK 기준으로
   재현성 확보 후 서명은 분리 검증. **앵커를 발행했다고 이 한계가 사라지지 않는다** —
   앵커는 "publisher 가 그때 이 해시를 공표했다" 만 증명하고, 소스↔바이너리 대응은
   증명하지 않는다(매니페스트 `anchor.note` 에 그대로 적혀 있다).
2. **publisher 단일 키 → k-of-n** — 지금 앵커를 올릴 수 있는 주소는
   `0x52B5dE96…f533` **하나뿐**이다. 그 키를 잃거나 빼앗기면 앵커 체계 전체가
   무의미해진다. `anchor-publishers.json` 의 `_policy` 에 "관리자가 늘면 각자 독립
   주소로 같은 해시를 앵커링하고 검증기가 k-of-n 일치를 요구한다" 로 방향만 적혀 있고
   구현은 없다.
3. **앵커 `data` 검사 강화** — 검증기의 `data` 검사가 sha256 **부분문자열 매칭**이라,
   그 해시 문자열이 어딘가 박힌 아무 tx 나 통과한다. `byeorin:release:1` 매직도
   `v=` / `commit=` 필드도 대조하지 않는다. 매직 버전 호환성 때문에 `30f5e85` 에서
   의도적으로 남겨둔 구멍이다.
4. **앱 내 빌드 커밋 표시** — 푸터가 `v0.5.4 (5)` 까지만 표시한다(`app-version.ts` 가
   네이티브 `versionName`/`versionCode` 만 읽음). 실행 중인 앱과 매니페스트를 **커밋
   단위로** 대조할 수단이 아직 없다.

### E. 벼린 환율 후속 ([RATES.md §8](./RATES.md))
0. ~~**"페깅 해제" 와 코드가 어긋나 있다**~~ — **닫힘 (2026-08-02).** §5 참고. 두 셸의
   페그 상수·환산 함수를 전부 제거했고 TTL 은 환산 없이 자기 정의로 표시된다. 대신
   **kWR 은 값 표시를 잃었다** — 페그가 유일한 값 출처였고, `rate-snapshot.json` 은
   EVM 주소 기반이라 ZION native kWR 항목이 없다. TTL 로 재려면 스냅샷에 denom 기반
   항목을 넣거나 ZION 쪽에서 따로 정해야 한다. **산식을 지어내지 않았다 — 미정.**
1. **갱신 동력이 없다** — 66 종 값은 2026-07-29 에 한 번 계산되고 고정됐다. 갱신 주체·
   주기·트리거 어느 것도 정해져 있지 않다. GDP 나 인구가 바뀌어도 스냅샷은 그대로다.
   **이 라운드에서 정하지 않은 가장 큰 항목.**
2. **안드로이드 토큰 목록 화면 이식 (진행 중)** — 커밋 기준으로 `TokenListPane` 은
   확장에만 있고, 안드로이드는 `c9a6771` 에서 CSS(149줄)만 들어갔다. 본 문서 갱신
   시점의 작업 트리에는 `apps/android/src/screens/TokenListPane.tsx`(338줄) ·
   `lib/token-visibility.ts`(375줄) 가 **미커밋**으로 존재하고 `App.tsx` 에 배선돼
   있다. **실기기·에뮬레이터 동작 확인 여부는 미확인.**
3. **1인당 산출 ≠ 임금** — `GDP / 인구 / 365` 는 하루 산출액이지 노동자가 받는 임금이
   아니다. 노동소득분배율·비경제활동인구·소득분포 어느 것도 반영되지 않았다.
   "노동자 1일 품삯" 이라는 원칙과 실제 산식 사이의 이 간극은 문서에만 적혀 있고
   좁히는 계획은 없다.
4. **스냅샷에 생성 시각이 없다** — `anchoredAt: 2026-07-29` 은 재현을 위해 박아 넣은
   고정 상수라 데이터 취득 시각과 다를 수 있다. 원본(World Bank)은 개정되므로 재실행
   결과가 달라질 수 있다.

---

## 8. 빠른 명령 reference

```bash
# 모노레포 빌드/테스트/타입체크
pnpm install        # lockfile 재생성
pnpm typecheck      # 8 워크스페이스 전체
pnpm test           # 9 워크스페이스 (firmware 제외)
pnpm build          # 전체 빌드

# 디자인 자동화
python scripts/make_dark_mode.py
python scripts/downsample_test.py
python scripts/generate_all_icons.py
python scripts/deploy_icons.py

# 브랜드 마이그레이션 (재실행 시)
python scripts/migrate_brand.py            # dry-run
python scripts/migrate_brand.py --apply    # 실제 적용

# 릴리스 검증 (매니페스트는 release 빌드 시 자동 생성)
# 파일명은 build.gradle 의 versionName 에서 조립된다 — 버전을 올리면 이름이 따라 바뀐다
cd apps/android && pnpm apk                 # → 벼린0.5.16.apk + 벼린0.5.16.apk.manifest.json
node scripts/verify-byeorin-apk.mjs 벼린0.5.16.apk 벼린0.5.16.apk.manifest.json
node scripts/anchor-release.mjs                              # 앵커 드라이런
BYEORIN_ANCHOR_KEY=0x… node scripts/anchor-release.mjs --send  # 실제 발행 (2건 발행됨)

# 앵커 publisher 키 (PowerShell — 시드는 화면에 안 보이게 입력받는다)
.\scripts\Set-AnchorKey.ps1 -Index 7        # BYEORIN_ANCHOR_KEY 채움
.\scripts\Set-AnchorKey.ps1 -Clear          # 지움

# 벼린 환율 스냅샷 재현 (네트워크 사용: World Bank + IMF + TTL Scan)
node scripts/build-rate-snapshot.mjs --out /tmp/repro.json
diff <(jq -S . rate-snapshot.json) <(jq -S . /tmp/repro.json)
git diff packages/wallet-sdk/src/rates/snapshot.ts   # --out 을 줘도 이 파일은 덮어써진다

# Git (origin = github.com/okneo31/byeorin, main 추적 중)
git status
git log --oneline -5
git push                                    # 추가 변경 후
```

---

## 9. 주요 인물·계정

- **사용자**: okneo31 (GitHub) / okneojjjajh@gmail.com
- **GitHub 리포**: <https://github.com/okneo31/byeorin> (private)
- **TTL 체인**: ChainID 7777, geth 1.13.15 포크, MetaMask 그대로 호환
  - eth_chainId = 0x1e61, eth_gasPrice ≈ 1 Gwei

---

## 10. Cross-document index

| 문서 | 역할 |
|---|---|
| [`docs/PLAN.md`](./PLAN.md) | **단일 진실원** — 제품·아키텍처·로드맵 (v0.5) |
| [`docs/VERIFIABILITY.md`](./VERIFIABILITY.md) | **검증 가능한 보안** — 원칙·현재 검증 가능한 것·아직 못 하는 것·로드맵 |
| [`docs/RATES.md`](./RATES.md) | **벼린 환율** — 원칙(1 TTL = 노동자 1일 품삯)·산식·두 앵커·재현 방법·API·**한계** |
| [`docs/CONTEXT.md`](./CONTEXT.md) | **본 문서** — 현재 상태 스냅샷, 세션 인수인계 |
| [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) | 시스템 다이어그램 + 모듈 책임 + 위협 경계 + 키 invariant |
| [`docs/CHANGELOG.md`](./CHANGELOG.md) | 커밋 단위 변경 기록 (v0.5 entry 포함) |
| [`docs/INSURANCE.md`](./INSURANCE.md) | 보험 시스템 v2 (849줄, 5개 kill criteria) |
| [`README.md`](../README.md) | 저장소 첫 화면 — 원칙 · APK 검증법 · 지원 체인 · 금고 구조 · 상태표 |
| [`SECURITY.md`](../SECURITY.md) | 취약점 신고 절차 · in scope · 문서화된 설계 한계 |
| [`LICENSE`](../LICENSE) | Apache License 2.0 원문 |
| [`NOTICE`](../NOTICE) | 창작재산권(okneo31) 표기 · 상표 조항 · 제3자 구성요소 |
| [`hardware/SPEC.md`](../hardware/SPEC.md) | HW 사양 v0 (외부 벤더 리뷰용). 검증 요구 F-11~F-14 |
| [`apps/android/README.md`](../apps/android/README.md) | 안드로이드 셸 — 금고 2겹 구조와 **막지 못하는 것** |
| [`firmware/README.md`](../firmware/README.md) | 펌웨어 빌드/레이아웃 |
| [`icons/dist/README.md`](../icons/dist/README.md) | 아이콘 패키지 플랫폼별 적용법 |

---

## 11. 새 세션 시작 시 권장 동작 (AI 에이전트용)

1. **본 문서 (`CONTEXT.md`)를 먼저 읽는다.** 핵심 결정·자산·다음 작업 5분 안에 파악.
2. **PLAN.md §9** 로 진입해 Q1 액션 중 하나를 시작하거나, 사용자에게 다음 작업 확정 질문.
3. **메모리 시스템** (`C:\Users\jjjaj\.claude\projects\D--TTLCOINWalet\memory\`)도 함께 활용 — 사용자 선호, 피드백, 닫힌 결정 디테일은 그쪽에 있음.
4. **자동 변환된 옛 잔재** (`branding/raw/*.svg`, `verification/icon-concepts/*.svg`)에 옛 곡괭이 그래픽이 남아있음을 인지. 새 곡괭이 아님.
5. **package.json name = `byeorin-wallet`**, 모든 패키지 `@byeorin/*`. 옛 `@nodong/*` 출현 시 마이그레이션 누락이므로 즉시 처리.
6. **HW 디바이스명은 "벼린 요세"** (Byeorin Yose). "벼린 콜드" 또는 "벼린 모루" 같은 옛 후보는 폐기.
7. **"TTL = 10/365 BTC" 는 결정상 해제됐다(2026-07-29, §5).** 메모리
   (`project_token_pegs`)에 옛 서술이 남아 있고, **셸 코드에는 상수가 아직 살아 있어
   잔액 화면이 실시간 BTC 시세를 따라간다.** 현행 환율 기준은
   [`docs/RATES.md`](./RATES.md). 이 불일치는 §5 에 기록돼 있다.
