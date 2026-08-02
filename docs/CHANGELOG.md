# Changelog

All notable changes to **벼린** (Byeorin / Worker's Wallet) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Until v0.1 tagging, each commit is its own release entry.

---

## [v0.5.16] btc-history: BIP157 실피어 시험 + 결함 9건 수정 · 릴리스 파일명에 버전 포함 — 2026-08-01

커밋: `15dd271`(BTC 이력 3중 트랙) → `1c78b20`(실피어 통합 시험) → `aa25ecc`(결함 9건 수정). 안드로이드 `versionCode 17 / versionName 0.5.16`.

### Added — BTC 이력 3중 트랙 (`15dd271`)
- Electrum · BIP157 라이트클라이언트 · WS 릴레이 3 경로. 상세는 [`docs/BTC-HISTORY.md`](./BTC-HISTORY.md).

### Tested — 실피어 통합 시험 (`1c78b20`)
- **E2E 실주소 스캔 성립**: 피자 tx 10,000 BTC 수취 + 다음 블록 지출까지 추적. SegWit 구간 717 레코드 전량 원문 재확인, 거짓음성 0. 정답은 구간 블록 원문을 따로 받아 독립으로 만들었다 — 필터로 필터를 검증하는 순환논증을 피하려고.
- 삼각 검증: BIP158 공식 벡터 = 실 Core 노드 바이트 = SDK 디코더, 8 개 높이 × 3 피어 전부 일치. SDK 무수정으로 testnet 동작.
- 헤더 96만 개 PoW 전량 통과 + 제네시스 앵커 검증, 89 피어 교차 불일치 0, Electrum↔BIP157 txid 집합 4/5 창 완전 일치, 주소 5 유형 입출력 양방향 매칭.
- **취약점 4 건을 실패하는 테스트로 고정했다** — 구현에 맞춰 기대값을 낮추지 않았다.

### Fixed — BIP157 결함 9 건 (`aa25ecc`, 보고서 [`docs/BIP157-FIX-ROUND.md`](./BIP157-FIX-ROUND.md))
사용자 관점에서 이것이 고쳐지기 전에는 **"피어가 거짓말하면 내 입금 이력이 조용히 사라질 수 있었다."**
- **D1 (심각) 블록 tx 목록이 머클루트로 검증되지 않았다.** 피어가 내 입금 tx 를 빼고 보내면 "이력 없음" 이 되고 예외도 안 났다. `computeMerkleRoot` 신설(txid 트리 · 홀수 복제 · CVE-2012-2459 짝중복 거부) + 블록마다 `header.merkleRoot` 대조. 실피어 블록으로 tx 제거 · tx 추가 · CVE 복제 3 종 위조 전부 거부, 정상 블록 통과 (피어 2 곳 재현).
- **D2 (심각) 헤더 요청 루프가 무한 반복.** 정직한 Core 상대로도 재현됐다 — 깊이 8 초과 재조직에서 진전 없이 영구 반복. 무진전 시 원인을 밝힌 예외로 즉시 종료 + 라운드 절대 상한.
- **D3 (심각) 피어 메시지 큐 무제한.** 응답 화이트리스트 + 2048 통/64MiB 상한. 폭주 실측 힙 증가 **64.6MB → 0.52MiB (124 분의 1)**, 상한 발동은 정확히 2,049 통째.
- **D4 (심각) 지출 이력 조용한 누락.** getdata 배치를 도착 순서가 아니라 높이 오름차순으로 스캔 + `knownOutpoints` 계약 명문화 + `emptyMatchedBlockHeights` 신호 필드.
- **N1 (심각) cfilter 배치 오염** — 매칭을 현 배치 전용 맵으로 한정.
- 중·경미 3 건: D5 ping 파싱 예외가 소켓 콜백 밖으로 탈출, N2 `cfilter.filterType` 미검증, N3 version nonce 32 비트 `Math.random` → CSPRNG u64.
- 부수 2 건: `P2PFrameDecoder` 진입 시 chunk 복사(셸 재사용 버퍼 안전), 시험용 전송 `setNoDelay` (실측 519ms → 259ms, 10 회 중 9 회 재현).
- 검증: BIP157 3 스위트 **118/118 통과**(수정 전 60 건 중 56 통과 · 4 실패), 패키지 전체 685 건 중 675 통과 · 10 skip · **0 실패**, `tsc --noEmit` 무오류. 실피어 5 곳 회귀 기준값과 전건 일치(tipHeight 960450 · 필터 300 · records 4), 성능 중앙값 **−31.6%**.
- **테스트 약화 없음**: 의도적 실패 4 건의 본문·기대값 diff 0 줄, `.skip`/`xit`/`xdescribe` 0 건. 테스트 변경은 모의 피어가 D1 이후에도 "정직한 피어" 로 남도록 픽스처 `merkleRoot` 를 실값화한 것뿐.
- **고치지 않고 남긴 것 5 건**은 `docs/BIP157-FIX-ROUND.md` §6 에 그대로 적혀 있다 (handleChunk closedErr 가드 없음 · `blockBatchSize > 16` 에서 정직한 피어도 상한 접촉 가능 · expectedRounds 의 2000헤더 가정 · 깊이 8 초과 재조직은 명시적 실패 · locator 가 지수 back-off 아님).
- 이 코드는 **아직 어느 셸에도 배선되지 않았다.**

### Changed — 릴리스 산출물 파일명에 버전이 들어간다
- `벼린.apk` / `벼린.apk.manifest.json` → **`벼린<versionName>.apk` / `벼린<versionName>.apk.manifest.json`** (이번 릴리스는 `벼린0.5.16.apk`).
- 이름은 하드코딩이 아니라 `apps/android/android/app/build.gradle` 의 `versionName` 을 읽어 조립한다 — 버전을 올릴 때 이름이 저절로 따라오지 않으면 매니페스트가 가리키는 파일과 실제 배포 파일이 어긋난다.
- 고정 이름이면 여러 버전의 APK 와 그 검증 근거를 동시에 둘 수 없었다. 매니페스트는 git 추적 대상이라 릴리스마다 별도 파일로 남는다.
- 검증 명령도 같이 바뀐다: `node scripts/verify-byeorin-apk.mjs 벼린0.5.16.apk 벼린0.5.16.apk.manifest.json`.

---

## [91d40b5…8a13047] rates + anchor: 벼린 환율 도입 · 온체인 앵커 실발행 · Stage E2/E3 — 2026-07-29

커밋 14개: `91d40b5` `606a218` `30f5e85` `8005923` `dabbdab` `560e39e` `b9b4263` `cdd2197` `be1e56f` `b44bc80` `65953a0` `c9a6771` `8a13047` (+ `555eb46` docs).

### Added (벼린 환율, `c9a6771` `8a13047`)
- **원칙: `1 TTL = 노동자 1일 품삯. 국적과 무관하다.`** 시장환율을 입력으로 쓰지 않는다 — 산식 어디에도 환율이 들어가지 않는다.
- 산식: `perTtl = 명목GDP(자국통화) / 인구 / 365`, `1 TTL = perTtl 단위의 t{ISO}`.
- `rate-snapshot.json` (1,037줄) — **66 종 산출 · 미해결 0 건**. `anchoredAt: 2026-07-29` 은 **고정 상수**다(실행 시각을 넣으면 "다시 돌려 git diff 가 비는지" 로 재현을 검증할 수 없다).
- `packages/wallet-sdk/src/rates/{index,types,snapshot}.ts` — 공개 API `rateByAddress` / `rateByIso` / `tokenAmountToTtl` / `ttlToTokenAmount` / `crossRate` / `unresolvedRates` / `snapshot`. 스냅샷은 import 되는 상수라 네트워크 호출이 없다.
- `scripts/build-rate-snapshot.mjs` (352줄) — 생성기. 제3자가 같은 입력으로 같은 값을 낼 수 있게 저장소에 둔다. `rate-snapshot.json` 과 `snapshot.ts` 를 한 번의 실행에서 함께 만든다.
- `apps/extension/entrypoints/popup/screens/TokenListPane.tsx` (333줄) + `lib/token-visibility.ts` (360줄) — 66 종 검색 · 개별 보기/가리기 · TTL 환산 가치 · 환율 근거 패널(GDP·인구·연도·ISO3·합성 여부).
- `docs/RATES.md` (253줄) — 주장하는 것 / **주장하지 않는 것**, 산식, 두 앵커, 재현 방법, API, 한계.
- i18n `tokens.*` 29 키 (ko/en).

### Decided — BTC 페깅 해제 (`c9a6771`)
- **앵커는 둘이고 서로 만나지 않는다.**
  - ① BTC **63,412.45 @ 2026-07-29 00:00 KST** → TTL 의 외부 시세. **이후 페깅 해제.**
  - ② 2025 명목GDP/인구 → 66 종 환율. 이후 외부 데이터를 보지 않는다.
- 옛 결정 "TTL = 10/365 BTC"(`a4b4a03`, 2026-07-25)는 **2026-07-29 앵커로 한 번 쓰고 끝났다.**
- BTC 값은 `rate-snapshot.json` 어디에도 들어 있지 않다 — 테스트 `BTC 앵커는 이 스냅샷 어디에도 등장하지 않는다` 가 그 분리를 지킨다.
- `crossRate(from, to) = to.perTtl / from.perTtl` 이라 TTL 의 절대 눈금은 약분된다. 앵커 ①이 흔들려도 ②가 정하는 상대 관계는 그대로다.
- `t{ISO}` 토큰은 **실제 그 나라 통화가 아니다.** 상환·예치·페그 어느 것도 없다.

### Changed (환율 데이터 정합성, `c9a6771` `8a13047`)
- **`tXOF` 가 코트디부아르 한 나라 값이었다.** XOF 는 서아프리카 8 개국 공용 통화라 그대로 두면 XOF 가 아니라 코트디부아르의 품삯이 된다. 회원국 GDP·인구를 합산해 `4,862.85 → 2,632.68` 로 바뀌었다.
- **`tAED` 가 2024 GDP ÷ 2025 인구였다.** 분자와 분모의 기준 시점이 다르면 1인당 값이 그만큼 왜곡된다. 같은 연도로 짝지어 고르게 고쳤다 — 스냅샷 실측 결과 `tAED` 는 GDP·인구 **모두 2024**, 나머지 65 종은 모두 2025. **연도 불일치 0 건.** (`docs/RATES.md` §8 의 "`tAED` 는 2024 GDP ÷ 2025 인구다" 서술은 이 수정 이전의 것으로 스냅샷과 어긋난다.)
- **유로존이 회원국 GDP ÷ EMU 인구였다.** 인구도 같은 20 개국 집합으로 합산(`358,664,361 → 352,231,059`), `perTtl 120.86 → 123.07`.
- **대만을 IMF 로 채웠다.** World Bank 에 대만이 없고 IMF 에도 자국통화 GDP 계열이 없어, `PPPGDP(국제달러) × PPPEX(자국통화/국제달러)` 항등식으로 복원했다. 달러 환산 GDP(`NGDPD`)는 시장환율이 이미 곱해진 값이라 쓰지 않았다. 유도가 맞는지 지어내지 않고 대조했다 — KOR/JPN/USA/DEU 에서 World Bank 자국통화 GDP 대비 오차 **0.00~0.02%**.
- 합성값 3 종(`tEUR` · `tXOF` · `tTWD`)은 `inputs.gdpSynthetic` 로 표시해 출처가 섞인 것을 숨기지 않는다.
- **테스트를 상태가 아니라 불변식으로 바꿨다.** "대만은 미해결이다" 를 단언하던 테스트 3 개가 대만이 채워지자 깨졌는데, 깨진 쪽은 코드가 아니라 테스트였다. 이제 "미해결 항목은 사유를 반드시 갖는다 / 미해결 통화는 조회 API 에 절대 잡히지 않는다 / IMF 폴백은 합성값 표시를 갖는다" 를 검사한다.

### Fixed (환율 조회 — 심볼 충돌, `c9a6771`)
- **주소로 찾는다, 심볼이 아니라.** 심볼 키였을 때 `tUSD` 를 대문자화하면 `TUSD`(이더리움 TrueUSD)와 같아져 TrueUSD 잔액에 벼린 환율이 붙었다. 실제로 그 버그가 있었고 `tUSD` 만 우연히 1 달러로 표시되고 있었다. 테스트가 이 오작동을 재현해 못 박았다.
- **환율을 모르면 `null` 이다. `0` 이 아니다.** `0` 은 화면에서 "가치 없음" 으로 읽힌다. 화면은 가치 자리를 비우고 수량만 보여준다.
- `perTtl` 34만 + `decimals` 18 조합(`tVND`)에서 `Number()` 한 번에 변환하면 정밀도가 깨진다. 정수부/소수부를 나눠 만든다 — 순진한 구현은 `1.0000000000000002`, 현재 구현은 `1`.
- 토큰 조회를 항상 `includeZero: true` 로. 토글에 묶여 있어 (a) 켤 때마다 RPC 를 다시 때리고 (b) 상위 목록에 잔액>0 만 담겨 "66 종을 검색한다" 는 목적 자체가 성립하지 않았다.

### Added — 온체인 릴리스 앵커 **실제 발행 2 건** (`be1e56f`, `c9a6771`)
```
0.5.3 (4)  tx 0xbaa318f21894b1accece2b1632d9212127face578ade117267d0f97ac66401c1
           block 1125713 · sha256 3c545e15…eeb1 · commit 560e39e
0.5.4 (5)  tx 0xca7039ea1a962db4bfb616dbbb5230c60d98f459a87ac6d14a1ac5a01b2e59fd
           block 1126124 · sha256 bf2436b1…82ce · commit b44bc80
publisher  0x52B5dE96dC298f98a0cDf9E694De1Cc55c28f533   (ChainID 7777)
```
- 기록기 출력만 믿지 않고 체인에서 직접 대조했다: tx 존재 · value 0 · receipt status `0x1` · `from` 이 publisher 와 일치 · `data` 를 UTF-8 로 풀면 페이로드 그대로.
- `anchor-publishers.json` 의 `publishers` 가 채워졌다(그전까지 빈 배열).
- 가스 실측: `eth_estimateGas` 27,224 × `eth_gasPrice` 50 gwei = **0.0013612 TTL/건**.
- **append-only 의 대가**: 0.5.3 앵커는 번역이 깨진 빌드를 가리킨다. 지울 수 없어 0.5.4 로 새 앵커를 올려 덮어 설명했다. 두 앵커 모두 체인에 영구히 남는다.
- **이 앵커가 증명하지 않는 것**: "publisher 가 그때 이 해시를 공표했다" 만 증명한다. 소스↔바이너리 대응은 재현 빌드가 필요하고 재현 빌드는 여전히 안 된다(매니페스트 `anchor.note` 에 그대로 적혀 있다).

### Fixed (검증기가 확인하지 않은 것을 초록불로 내주고 있었다, `30f5e85`)
음성 테스트(통과해선 안 되는 케이스) 12 건으로 찾았다.
- **`publishers` 가 빈 배열일 때 아무 주소로 만든 트랜잭션이 `[OK]` 로 통과했다.** 경고도 한 줄 없었다. 주석에는 "경고와 함께 건너뛴다" 라고 적혀 있었지만 경고가 구현돼 있지 않았다. `publishers` 가 실제로 빈 배열이었으므로 **이게 당시 라이브 상태였다.**
- chainId 미검사 — `TTL_RPC_URL` 로 아무 체인이나 가리키면 통과했다. `eth_chainId` 대조 추가(RPC 2회, 여전히 O(1)).
- pending tx 가 OK 였다 → SKIP + 경고. `tx.from` 이 없을 때 빈 문자열이 목록에 우연히 매칭되던 여지 제거.
- 기준을 명시: **확실히 틀린 것은 FAIL, 확인할 수 없는 것은 SKIP.**
- 기록기도 자기 검증기가 FAIL 을 낼 앵커를 발행할 수 있었다 → 전송 전 chainId·publisher 주소·잔액 3중 사전검사.
- **고치지 않고 남긴 구멍**: `data` 검사가 sha256 **부분문자열 매칭**이라, 그 해시 문자열이 어딘가 박힌 아무 tx 나 통과한다. `byeorin:release:1` 매직도 `v=`/`commit=` 필드도 대조하지 않는다. 매직 버전 호환성 때문에 기록만 하고 뒀다.

### Fixed (검증기 종료코드, `be1e56f`)
- 화면에는 `✅ 일치` 가 찍히는데 종료 코드는 **127** 이었다. 마지막 줄의 `process.exit()` 를 앵커 검사의 fetch 직후에 호출해 Windows libuv 가 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 로 죽고 exit 1 이 127 로 덮였다. 앵커가 없던 동안에는 fetch 경로를 안 타서 드러나지 않다가 발행하자마자 나왔다.
- 제3자가 스크립트로 돌리는 도구라 종료 코드가 화면 출력만큼 중요하다 — `verify && deploy` 가 정상 산출물을 거부하게 된다. `process.exitCode` 만 정하고 이벤트 루프가 스스로 비워지게 뒀다.
- 성공만 고치고 실패 감지가 죽으면 더 나쁘므로 양쪽 확인: 정상 exit 0 (1.2초) / sha256 조작 exit 1 / 없는 txHash exit 1.

### Added (publisher 키 파생, `8005923` `cdd2197`)
- `scripts/derive-publisher-key.mjs` — 시드구문 → 앵커 publisher 개인키. 시드는 **stdin 으로만** 받는다(argv 는 프로세스 목록·셸 히스토리에 남는다). BIP-39/BIP-32 를 다시 구현하지 않고 지갑과 같은 `@byeorin/wallet-sdk` 코드 경로를 쓴다 — 두 경로(raw 파생 / `Wallet.account`)로 각각 구해 대조하고 어긋나면 키를 출력하지 않고 죽는다.
- `scripts/Set-AnchorKey.ps1` — PowerShell 래퍼. `Read-Host -AsSecureString` 으로 받아 `BYEORIN_ANCHOR_KEY` 에 넣는다. `-Persist` 는 HKCU 레지스트리에 **평문**으로 남고 그 노출 범위를 스크립트가 명시한다.
- 루트에 `viem` 추가(기록기·파생 스크립트용).

### Fixed (Windows/PowerShell 인코딩 3건, `cdd2197`)
- **나가는 방향 — 한국어 시드가 통째로 `?` 가 됐다.** PS 5.1 의 `$OutputEncoding` 기본값이 ASCII 라 네이티브 프로세스 stdin 으로 보낼 때 한 글자도 남지 않았다. 전역 변수 상태에 기대는 구조를 버리고 UTF-8 바이트 → base64 로 감싸 보낸다(`--stdin-base64`). 전선 위에는 ASCII 만 흐르므로 어떤 코드페이지도 훼손할 수 없다. 사용자 환경을 재현해 대조 검증(평문 파이프 실패 / base64 성공, wordlist korean).
- **들어오는 방향 — 오류 메시지를 읽을 수 없었다.** `[Console]::OutputEncoding` 이 CP949 라 node 의 UTF-8 출력이 `?좏슚???쒕뱶援щЦ` 로 깨져 진단이 불가능했다. UTF-8 로 맞추고 세션 전역 상태이므로 `try/finally` 로 되돌린다.
- **실패가 원인을 말하지 않았다.** 단어 수 / 각 사전에 없는 단어 **개수** / 전부 ASCII 인지 / U+FFFD 혼입을 센다. 시드 내용이나 어느 단어가 틀렸는지는 내보내지 않는다 — 그러면 오류 메시지가 유출 경로가 된다. 이 진단이 1번을 잡았다.
- `anchor-publishers.json` 이 JSON 으로 파싱되지 않았다 — 닫는 중괄호 뒤에 `ro` 두 글자가 붙어 있었다. 그 상태로는 기록기도 검증기도 파일을 못 읽는다.

### Added (Stage E2/E3 — 확장, `606a218`)
- `screens/AddressMatrix.tsx` · `AddressbookPane.tsx` · `ActivityPane.tsx` · `SendPane.tsx` — popup `App.tsx` 2585 줄을 화면 단위로 쪼갰다(`App.tsx` 는 오히려 짧아졌다).
- 주소록 저장 계층은 새로 만들지 않았다 — shell-core 의 `Addressbook` + `ChromeLocalBackend` 에 UI 만 붙였다. self 엔트리는 계정 × 체인 매트릭스에서 자동 sync.
- 받는 주소 입력을 `textarea` → `input`. HTML `list` 속성은 `input` 에만 있어 `textarea` 로는 주소록 자동완성이 아예 동작하지 않는다.
- 토큰 송금은 shell-core 를 고치지 않았다 — `TransferIntent.data` 를 `EvmAdapter` 가 보므로 `Erc20.transfer()` 가 만든 intent 를 기존 `walletStore.transfer` 에 그대로 넣는다.
- `vitest include` 에 `entrypoints/**/*.test.ts` 추가 — `src/` 만 보고 있어 새 테스트 16 개가 조용히 실행되지 않고 있었다.
- i18n 52 키 신규 (ko/en).

### Added (Stage E2/E3 — 안드로이드 이식, `560e39e`)
- `apps/android` 는 확장 popup 의 **별도 복사본**이라 확장에 넣은 화면이 자동으로 따라오지 않는다. 4 화면을 "그대로 옮긴다" 원칙으로 이식했다 — 여기서 폰에 맞게 다시 설계하면 두 셸이 갈라져 다음 이식이 매번 비싸진다.
- 실제로 달라진 것 셋: import 경로 / 주소록 저장 백엔드(`ChromeLocalBackend` → `LocalStorageBackend`) / 받는 주소 input 의 `className="input"`(안드로이드 `styles.css` 에 bare input 규칙이 없어 font-size < 16px 이면 포커스 시 화면이 확대된다).
- 기존 `SendPane` 을 잃지 않았는지 추측하지 않고 대조했다 — 추출 직전 커밋의 확장 `App.tsx` 1171–1358 과 안드로이드 1209–1397 이 끝 빈 줄 하나 외 byte-identical.
- CSS 는 **모바일 오버라이드 블록 앞에** 넣었다. 뒤에 넣으면 터치 타깃 확대 같은 기존 오버라이드가 무력화된다.
- 폰 화면에서 재검토가 필요하나 **이번에 손대지 않은 것**: `.addr-matrix` 의 `max-height 280px` 내부 스크롤(420px 팝업 제약) · 체인 이름 칸 92px 고정폭 · 활동 내역 3줄 카드 구조 · `#send-amount` 13px 폰트(포커스 시 확대).

### Fixed (활동 내역이 아무것도 못 찾고 14초를 태우고 있었다, `dabbdab`)
```
거래 있는 주소   0 건 / 13.8 초  →  20 건 / 1.39 초
거래 없는 주소   0 건 / 13.8 초  →   0 건 / 0.41 초
```
- **explorer 경로가 애초에 존재하지 않았다.** SDK 주석은 "TTL Scan 이 etherscan 호환인지 검증 필요한데 그렇다고 가정하고 실패하면 fallback" 이었다. 실측하니 호환이 아니다 — 자체 규격이고 `/api` 에 catch-all 라우트가 없어 404, 그래서 **항상** fallback 이었다. 진짜 경로는 `/api/indexer/address/:addr/txs`.
- 응답에 성공하면 0 건이어도 정답으로 취급한다 — "형식이 아니다"(null)와 "물어봤고 없다"(`[]`)를 구분한다. 구분하지 않으면 거래 없는 계정이 13 초를 기다린 끝에 똑같이 "없음" 을 본다.
- **모킹 편의로 둔 우회로가 실사용에 41 초를 얹고 있었다.** `rawGetLogs` 가 viem `client.getLogs` 를 먼저 시도했는데, viem 은 우리가 넘기는 raw topics 배열을 처리하지 못한 채 41.1 초를 매달렸다가 타임아웃한다. 같은 질의를 `client.request` 로 직접 쏘면 617ms. 테스트도 `client.request` 를 모킹하게 고쳐 실제 경로와 테스트를 일치시켰다 — 이번 건이 정확히 그 괴리에서 나왔다.
- ERC-20 은 어느 경로를 타든 `eth_getLogs` 로 따로 긁는다. tx 단위 인덱서로는 **받은** 토큰 전송을 볼 수 없다(받는 주소는 tx 의 from/to 어디에도 없고 로그 topic 에만 있다).
- 인덱서 자동 감지는 체인 id 7777 에 한정 — 남의 explorer 에 TTL 전용 경로를 찔러 왕복을 버릴 이유가 없다.
- (`scan.ttl1.top` 의 `/api/*` 에 CORS 헤더가 이번에 붙었다. 그 전에는 확장·WebView 에서 이 경로를 쓸 수 없었다.)

### Fixed (낡은 i18n dist 가 APK 에 실려 번역이 키 그대로 나왔다, `b44bc80`)
- 실기기 화면에 버튼이 `addresses.title`, `addressbook.title` 로 떴다. 원인은 워크스페이스 의존성을 빌드하지 않고 앱만 빌드한 것 — `@byeorin/i18n` 은 `dist/` 로 해석되는데 새 키를 `src` 에만 넣고 패키지를 다시 빌드하지 않아 낡은 dist 가 조용히 APK 에 실렸다. `t()` 는 키가 없으면 키 문자열을 그대로 돌려준다.
- **typecheck 도 test 도 이걸 못 잡는다** — `t()` 는 string 을 받으므로 없는 키도 타입 오류가 아니고, 카탈로그 내용은 테스트하지 않는다. 빌드 순서 문제라 빌드에서 막았다: android `sync` 와 extension `build` 앞에 `pnpm -r --filter <pkg>^... build` 를 붙임.
- 번들에서 "체인별 주소" · "주소록" · "다시 시도" 문자열이 실제로 검출되는 것까지 확인.

### Added (TTL 발행 토큰 66 종 자동 감지, `b44bc80`)
- 레지스트리의 `BUILTIN` 에 TTL(7777) 항목이 **0 개**였다 — 지금까지 TTL 토큰은 사용자가 주소를 손으로 넣지 않으면 아무것도 안 보였다. 그 사이 체인에는 스테이블 66 종이 발행돼 있었다.
- `packages/wallet-sdk/src/tokens/ttlscan.ts` — `/api/tokens` 를 읽어 registry 에 얹는다.
- **신뢰 경계를 흐리지 않았다** — 이 목록은 **무엇을 조회할지**만 정한다. 잔액은 여기서 받지 않고 반드시 체인에서 `balanceOf` 로 읽는다. 익스플로러가 거짓 목록을 줘도 없는 토큰을 조회해 0 이 나올 뿐 잔액을 부풀릴 수 없다.
- 방어: `0x`+40hex 가 아닌 주소는 버린다 · `decimals` 가 정수가 아니면 **추측해서 18 을 넣지 않고** 그 항목을 버린다(자릿수를 틀리면 잔액이 통째로 거짓이 된다) · 중복 주소는 하나만 · 실패(HTTP/형식/타임아웃 8초)는 던지지 않고 빈 배열이라 빌트인으로 계속 동작 · localStorage 에 저장하지 않는다(체인 쪽 사실과 사용자가 손으로 추가한 토큰이 섞이면 지울 수도 없다).
- `discoverEvmTokens` 의 `maxRpcCalls` 50 → 256. 50 은 66 종을 조용히 잘라냈고 잘린 토큰은 잔액이 있어도 화면에 안 나왔다.
- 실측(TTL 메인넷, 2026-07-29): 목록 66 개 872ms · `balanceOf` 66 건 694ms.

### Added (Solana 읽기 전용 RPC fallback, `91d40b5`)
- 백로그 #26. 읽기(`getBalance`)는 publicnode → OnFinality → dRPC 순으로 넘어가고 **송금은 넘어가지 않는다** — blockhash 를 A 에서 받아 B 로 보내면 tx 가 깨진다.
- 그 구분을 주석이 아니라 **자료구조로 강제**했다. `readEndpoints` 배열과 `writeConnection` 은 별개 필드라 쓰기 경로에서 fallback 목록에 닿을 방법 자체가 없다. `buildTransfer` 의 `getLatestBlockhash` 도 읽기지만 write 쪽에 붙였다 — 여기가 정확히 그 버그가 나는 지점이다.
- `disableRetryOnRateLimit: true`. web3.js 가 429 에서 자체 sleep 후 재시도하면 우리 fallback 이 돌지 못하고 popup 이 그냥 멈춘다.
- 타임아웃 읽기 6s / 쓰기 20s. 쓰기가 긴 것은 재시도 불가 호출이라 — 성급히 끊으면 "실패로 보이지만 실제로는 전파된" tx 가 생겨 이중 송금을 유도한다. 끊기 위한 값이 아니라 영구 hang 방지 상한.
- 실패 판정: 타임아웃/네트워크·CORS/HTTP 4xx·5xx/provider 고유 코드는 재시도, JSON-RPC 표준 요청오류(-32600대)는 즉시 throw.
- **실측(2026-07-28): 2·3순위는 무키 상태에서 각각 429/400 을 돌려준다. 지금은 실질 이중화가 아니다.** 목록만 보고 이중화됐다고 착각하지 않도록 코드 주석에 적어뒀다.

### Known limitations (이번 라운드에서 해결되지 않음)
- **"BTC 페깅 해제" 가 코드에 반영되지 않았다.** `apps/extension/entrypoints/popup/App.tsx` · `apps/android/src/App.tsx` 의 `TTL_PEG_BTC = 1000/365/100` 상수가 그대로 남아 있고, 잔액 화면의 TTL 가치는 이 비율 × Binance 실시간 BTC 시세로 계산된다. 배포된 0.5.4 에서 TTL 표시 가치는 지금도 BTC 를 따라 움직인다.
- **환율 스냅샷 이후 변동을 만드는 동력이 없다.** 66 종 값은 2026-07-29 에 한 번 계산되고 고정됐고, 갱신 주체·주기·트리거 어느 것도 정해져 있지 않다.
- **재현 빌드는 여전히 보장되지 않는다.** 앵커를 발행해도 소스↔바이너리 대응은 증명되지 않는다.
- **publisher 가 단일 키다.** `0x52B5dE96…f533` 하나뿐이고 k-of-n 은 방향만 문서에 있고 구현이 없다.
- **안드로이드에 토큰 목록 화면이 없다.** 이 커밋 범위에서 `TokenListPane` 은 확장에만 들어갔고 안드로이드에는 CSS 149 줄만 들어갔다. (이식은 이 엔트리 작성 시점에 미커밋 상태로 진행 중.)
- **`1인당 산출 ≠ 임금`.** `GDP / 인구 / 365` 는 하루 산출액이지 노동자가 받는 임금이 아니다. 노동소득분배율·비경제활동인구·소득분포 미반영.
- **활동 내역이 토큰 `decimals` 를 돌려주지 않아** 데스크톱과 같이 18 로 가정한다(`606a218` 에 기재).

### Artifact
- `top.ttl1.byeorin` **v0.5.4 (versionCode 5)** · 5,261,688 B · sha256 `bf2436b1…82ce`
- 매니페스트 출처: commit `b44bc80` (main), `workingTreeClean: true`
- 앵커: `0xca7039ea…59fd` @ block 1126124 (ChainID 7777)
- 툴체인: Node v24.15.0 · Gradle 8.14.3 · AGP 8.13.0 · compileSdk 36 / minSdk 24 / targetSdk 36
- APK 를 풀어 안을 직접 확인했다 — 빌드 통과와 번역이 실제로 실렸다는 것은 다른 문제고 직전 릴리스가 정확히 그 차이에서 깨졌다. "체인별 주소" · "주소록" · "보유 {amount}" 전부 `assets/public/assets` 에서 검출, ttlscan 토큰 로더도 포함.

### Test metrics (본 문서 갱신 시 재실행 · 2026-07-29)
- `pnpm test`: **450 passed / 9 skipped** — i18n 19 · wallet-sdk 266 · shell-core 52 · extension 113.
- `pnpm typecheck`: **9 워크스페이스 전부 통과.**
- 신규 테스트 파일 실측: `rates` 44 · `token-visibility` 38 · `activity-pane` 19 · `solana-rpc-fallback` 18 · `token-send` 16 · `addressbook-ui` 8 · `ttlscan-tokens` 7.

---

## [58bbbe5…76d7820] verifiability: 검증 가능한 보안 — 릴리스 검증 체계 + 금고 하드웨어 바인딩 + 공개 저장소 준비 — 2026-07-26

커밋 8개: `58bbbe5` `c1d85a1` `08e954b` `2316a0c` `83f372e` `b33ebf3` `dfdaff7` `76d7820`.

### Added (android — 금고 하드웨어 바인딩, `58bbbe5`)
- `apps/android/android/app/src/main/java/top/ttl1/byeorin/VaultCryptoPlugin.java` (158줄) — 로컬 Capacitor 플러그인 `isAvailable`/`wrap`/`unwrap`. AndroidKeyStore 에서 AES-256 키 생성, StrongBox 우선 시도 후 미탑재 단말은 TEE 폴백. 서드파티 의존성 0.
- `apps/android/src/vault-hw.ts` (146줄) — shell-core `PersistentBackend` 를 감싸는 백엔드. `EncryptedKeystoreStore` 가 저장소를 인터페이스로 주입받는 구조라 **shell-core 변경 0줄**.
- 금고 계층 순서: `시드 → AES-GCM(scrypt(비밀번호)) → AES-GCM(AndroidKeyStore 키) → localStorage`. 바깥 겹의 키는 칩 밖으로 나오지 않아, 저장 파일만으로는 그 폰 밖에서 복호화를 시작할 수 없다 — 오프라인 대입 경로가 사라진다. 하드웨어 계층이 뚫려도 남는 것은 scrypt 로 잠긴 blob.
- 하드웨어를 쓸 수 없으면 보호 수준을 낮춰 저장하지 않고 실패한다.
- `setUserAuthenticationRequired` 는 켜지 않음 — 생체 재등록/화면잠금 변경으로 키가 무효화되면 금고를 못 여는 사고가 난다.
- `apps/android/README.md` — 이 계층이 **막지 못하는 것**(칩 벤더/OEM, 물리 공격, 잠금 해제된 단말) 명시.

### Added (릴리스 검증 체계, `c1d85a1`)
- `apps/android/scripts/release-manifest.mjs` (165줄) — release 빌드마다 매니페스트 자동 생성. 파일 SHA-256, 서명 인증서 지문, 출처 커밋/브랜치, **작업 트리 청결 여부**, 툴체인 버전, `claims`(주장하지 않는 것).
- `scripts/verify-byeorin-apk.mjs` (122줄) — 제3자용 검증기. 의존성 0, 저장소 없이 파일 하나로 동작. 우리 서버에 아무것도 묻지 않는다.
- `apps/android/scripts/gradle.mjs` — release 빌드 후 매니페스트 자동 생성 (매니페스트 없는 APK 를 만들지 않는다).
- `docs/VERIFIABILITY.md` — 원칙, 공개/비공개 경계(Kerckhoffs), 지금 검증 가능한 것, **아직 못 하는 것**, 로드맵. 난독화 방향은 명시적으로 기각.
- `hardware/SPEC.md` F-11~F-14 — 재현 빌드 / 온체인 앵커 기반 정품 증명 / 사용자 엔트로피 혼합 / 멀티벤더 쿼럼의 한 다리.
- 공개 서명 인증서 지문: `303f801bb44af8c494b6e89844fbe86c36bd6f48ab404a4b6c0228fa3f103480`

### Added (온체인 릴리스 앵커 — 구현 완료, **발행 대기**, `76d7820`)
- `scripts/anchor-release.mjs` (154줄) — 매니페스트 해시를 TTL 체인(ChainID 7777)에 기록. **컨트랙트를 쓰지 않는다** — 0-value 트랜잭션 `data` 에 사람이 읽는 텍스트 한 줄: `byeorin:release:1|sha256=<64hex>|v=<name>+<code>|commit=<40hex>`.
- `scripts/verify-byeorin-apk.mjs` 에 4번째 검사 추가 — `eth_getTransactionByHash` **1회**(O(1))로 ① tx 존재 ② `from` 이 공개 publisher 목록에 있는가 ③ `data` 에 해당 sha256 이 있는가. 검증기는 여전히 **의존성 0**(순수 fetch), viem 은 기록기에서만 사용.
- `anchor-publishers.json` — publisher 허용 목록. 단일 키로 시작하며 그 약점을 문서에 명시. 목록이 비면 `from` 검사를 건너뛰고 경고.
- append-only — 수정·폐기 기능 없음. 커밋 안 된 변경이 섞인 빌드는 기록기가 **거부**한다.
- **드라이런만 확인. 실제 앵커 트랜잭션은 미발행** — publisher 키와 자금이 필요하다. `anchor-publishers.json` 의 `publishers` 는 현재 빈 배열.

### Added (공개 저장소 준비, `b33ebf3`)
- `LICENSE` — Apache License 2.0 원문 (apache.org 에서 수령).
- `NOTICE` — 창작재산권 okneo31 명시 + 상표 조항(§6, 포크는 개명 필요) + 제3자 구성요소.
- `README.md` — 원칙, APK 검증법, 지원 체인(16 슬롯 / 9 어댑터), 금고 2겹 구조, **못 하는 것을 포함한 상태표**.
- `SECURITY.md` — 취약점 신고 절차(72시간 목표 응답), in scope, **문서화된 설계 한계**(칩 벤더·물리 공격·재현 빌드 미보장), 서명 지문 공개.
- 라이선스 = Apache-2.0 으로 확정. 자체 라이선스는 SPDX/GitHub/npm/기업 스캐너가 인식 못 하면 `unknown license` 로 차단되므로 채택하지 않았다.

### Measured — 재현 빌드는 **안 된다** (`2316a0c`)
추측하지 않고 측정했다.

```
증분 빌드 직후          cd3fcb6d27264d60c63cc61575990fc541078e8d2979e3487fdbda7752575b67
gradlew clean 후 재빌드  5363e84330ca8b6d153e5e603830fb7691b6c38421f6585d6b61284ab19002dc
```

- **같은 머신·같은 커밋·같은 툴체인인데 바이트가 다르다.** 다른 사람·다른 머신은 말할 것도 없다.
- 앞서 `08e954b` 에서 재빌드 후 해시가 같게 나온 것은 Gradle 이 130개 태스크를 up-to-date 로 재사용한 증분 빌드였고, 결정성의 근거가 아니었다 — 그렇게 서술했던 것을 문서에서 정정.
- 결과: 매니페스트의 `commit` 이 그 바이트를 만들었다는 **증명은 없다.** 현재는 우리 주장이다.
- 이 사실은 앵커링에도 걸린다 — 재현 빌드 없이 하는 앵커링은 "사실"이 아니라 "주장"을 못 박는다.

### Fixed (매니페스트 정직성, `2316a0c`)
- `벼린.apk` 가 git 에 추적되고 있었다. `.gitignore` 규칙을 **이미 추적 중인 파일 뒤에** 넣어 효력이 없었던 탓에, 빌드마다 5MB 바이너리가 변경으로 잡혀 "작업 트리 더러움" 신호가 상시 켜져 있었다. `git rm --cached` 로 추적 해제.
- 더러움 판정에서 산출물 자신(매니페스트)을 제외. 빼지 않으면 "매니페스트를 쓰는 행위가 트리를 더럽혀 다음 매니페스트가 더럽다고 말하는" 자기참조에 빠진다.
- git 호출에 `core.quotepath=false` — 안 붙이면 한글 경로가 8진 이스케이프로 나와 경로 비교가 맞지 않는다.
- 금고 승급 버그(`58bbbe5`): 셸의 "내용 같으면 저장 건너뛰기" 최적화 탓에 옛 금고가 열리기만 하고 다시 봉인되지 않았다. `lastReadWasWrapped` 로 강제 재기록.

### Changed (이력 재작성, `dfdaff7`)
- 5MB APK blob 3개를 이력에서 제거 (force push). `.git` 42MB → 21MB, 이력 내 `벼린.apk` 0건.
- 검증: 커밋 39 = 39, 파일 455 = 455, 트리 diff 없음 — **소스 유실 없음**.
- 커밋 SHA 가 전부 바뀌어 직전 매니페스트가 존재하지 않는 커밋(`a665666`)을 가리켰다. 새 HEAD 기준으로 재생성.

### Verified (에뮬레이터 실측, `58bbbe5`)
- CDP 로 localStorage 직접 확인. 이전 빌드 금고 `{"v":1,"kdf":"scrypt","N":65536,…}` → 새 빌드 덮어 설치 후 잠금 해제 시 `{"hw":1,"iv":…,"ct":…}` 로 자동 승급, scrypt 파라미터가 저장소에서 완전히 사라짐. 계정 `0xf39F…2266` 그대로 복원.
- 앱 재시작 후 봉인된 금고를 읽는 경로 확인.
- `isAvailable → {available:true, strongBox:false}` (에뮬레이터는 TEE 폴백).

### Artifact
- `top.ttl1.byeorin` **v0.5.2 (versionCode 3)** · 5,221,596 B · sha256 `5363e843…002dc`
- 매니페스트 출처: commit `b33ebf3` (main), `workingTreeClean: true`
- 툴체인: Node v24.15.0 · Gradle 8.14.3 · AGP 8.13.0 · compileSdk 36 / minSdk 24 / targetSdk 36

---

## [v0.5] brand: 노동자의 지갑 → 벼린 (Byeorin) 전면 마이그레이션 + 디자인 시스템 v2 — 2026-05-18

### Brand
- 마스터 브랜드 확정: **벼린** (단조+핵심 이중의미). 포지션 슬로건 "노동자의 지갑" 유지.
- HW 디바이스명: **벼린 요세 (Byeorin Yose)**. 요세=요새, 시드를 지키는 거점.

### Changed (마이그레이션, 185 파일 / 958 replacement, `scripts/migrate_brand.py`)
- 패키지 scope: `@nodong/*` → `@byeorin/*` (5 packages)
- 영문/한글 정식명: `Nodong`/`NODONG_*`/"노동자의 지갑" → `Byeorin`/`BYEORIN_*`/"벼린"
- 펌웨어 보드: `nrf52840_nodong_cold.overlay` → `nrf52840_byeorin_yose.overlay`
- 슬로건 "노동자의 지갑이 세상을 자유롭게"는 placeholder 보호로 그대로 유지

### Added (브랜드 디자인 자산)
- 마스터 심볼: `logo0.{png,svg,_dark.png}` — 모루+불꽃 컨셉 (단조의 순간)
- Lockup 가로/세로 + 워드마크 한/영 (산세리프 Pretendard Black 계열)
- `icons/dist/` — iOS/Android/Web/PWA/Win/macOS/Social 64 파일 일괄
  + favicon.ico, manifest.webmanifest, head-snippet.html 메타파일
- 컬러 팔레트: 잉걸 오렌지 `#E84D1A` / 모루 차콜 `#1A1A1A` / 강철 실버 `#9CA3AF` / 땀 블루 `#2E78D2` / 종이 화이트 `#FAFAF7` / 밤 모루 `#0B0B0D`
- 신규 스크립트: `make_dark_mode.py` (HLS 명도 반전), `downsample_test.py`, `generate_all_icons.py`, `deploy_icons.py`

### Changed (design-system)
- `tokens.css`/`tokens.ts` 컬러 값 새 브랜드 팔레트로 교체 (`--nd-*` prefix는 코드 호환성 위해 유지)
- 시멘틱 aliases 추가: `--nd-ember`(=red), `--nd-anvil`, `--nd-night`, `--nd-steel`, `--nd-sweat`
- `Logo.tsx` 새 모루+불꽃 SVG로 완전 재작성 (옛 곡괭이 컨셉 폐기)

### Distributed (앱별 자산 배포, `scripts/deploy_icons.py`)
- `apps/web/public/` — favicon, apple-touch, og, manifest 6 파일
- `apps/extension/public/icon/` — 16/32/48/128 4 파일
- `apps/desktop/src-tauri/icons/` — Tauri 빌드용 5 파일 + `icon.iconset/` 폴더 (macOS .icns 입력)
- `apps/mobile/assets/AppIcon.appiconset/` + `android-icons/` — RN bare workflow용

### Fixed
- `apps/desktop` Portfolio.tsx:111, Wallet.tsx:109 — implicit any 보완 (`b: bigint`)

### Verified
- `pnpm typecheck` 8/8 워크스페이스 통과 (design-system 갱신 후 재검증 통과)

---

## [c04a852] harden: review wave 5 — 2nd-pass vulnerability hardening — 2026-05-16

### Added
- `signEvmMessage(signer, address, message)` helper in SDK (EIP-191) — extension can now drop its inline hash construction. Byte-equivalence vs `viem.signMessage` verified.
- `KEYSTORE_PARAMS_FAST` preset (scrypt N=2^16) for mobile / low-end devices; default `KEYSTORE_PARAMS_DEFAULT` bumped to N=2^17 (≈256 MB working set).
- SLIP-0010 ed25519 conformance: 4 tests against canonical spec vectors.
- Cross-vendor regression: Aptos / Solana / Cosmos / Osmosis address derivation validated against each chain's official SDK.
- Tron recovery boundary tests: rejects v ∈ {2, 26, 29, 255}.
- `.github/workflows/ci.yml` — typecheck + test + build + `pnpm audit` gate.

### Changed
- Extension popup ↔ background protocol: 128-bit nonce binding. Direct-URL hijack of `connect.html` / `confirm.html` now rejected with friendly Korean error.
- `sender.id === chrome.runtime.id` guard on every message branch.
- `chrome.runtime.onSuspend` rejects pending requests (Service Worker termination safety).
- `WalletStore`: explicit lock-vs-inflight-transfer policy (broadcast completes, subsequent calls throw), idempotent concurrent `unlock()`, explicit-adapter cache bypass.
- `detectWordlist`: mixed Korean/English now rejected with clear Korean error.
- `prj.conf` (firmware) production preset: CONSOLE/SERIAL/PRINTK/ASSERT/DEBUG=n, BLE_SIGNING=n, CONFIRM_TIMEOUT=60s.
- All firmware transport/se/keys files now carry `SECURITY-CRITICAL` header banners.

### Fixed
- BLE write callback (firmware): pre-callback length / offset / null guards.
- HID reassembly (firmware): `rx_reset()` now memsets the buffer on every IDLE transition.
- Extension connect/App: removed origin URL fallback (spoofing risk).
- EIP-6963 announce: documentation clarified that no account leak occurs.

### Security
- `pnpm audit`: 24 advisories → 1 low (Critical 1→0, High 8→0, Moderate 13→0).
- Root `pnpm.overrides`: `protobufjs ^7.5.8`, `axios ^1.15.2`, `fast-xml-parser ^5.7.0`.
- `.gitignore` hardened: env / secrets / keys / keystores / mobileprovisions patterns.
- SE050: anti-rollback `get` / `increment` prototypes added.
- `WalletStore.test.ts`: 20 new tests covering 6 invariants.

### Test metrics
- SDK: **83 pass / 9 skipped / 0 fail** (was 63).
- shell-core: **37 pass** (was 14).

---

## [a334e20] feat: review wave 4 — insurance v2 + keystore + ext confirm + RN UI + Tron fix — 2026-05-16

### Added
- `docs/INSURANCE.md` (849 lines) — v2 standalone insurance system design. Recommends HW = KB insurance bundle + SW = Nexus/InsurAce distribution + self-pool permanently deferred. 5 kill criteria, legal-first roadmap, 벼린 identity alignment check.
- `packages/shell-core/src/keystore.ts` — scrypt (N=2^16) + AES-GCM `EncryptedKeystoreStore` with `LocalStorageBackend` + `ChromeLocalBackend`.
- `apps/extension/entrypoints/confirm/` — consent popup for `personal_sign` and `eth_sendTransaction`. EIP-191 prefixed hash + v=recovery+27. Hard-enforces chainId 7777 and rejects contract calls (data != 0x) until v0.3.
- `apps/mobile/src/ui/` — RN primitives (Button / Card / Input / AddressDisplay / AmountDisplay). 3 screens (Home / Account / Send) migrated from inline styles to primitives.

### Fixed
- **TRON adapter signature** (production-critical silent failure risk): TronWeb v6 expects `r ‖ s ‖ (recovery + 27)` — we were sending raw recovery 0/1. `applySignatures` now normalizes `+27`, while `27/28` pass through unchanged (HW signer path). New offline verification test enforces byte-for-byte equality.

### Test metrics
- SDK: **63 pass / 9 skipped / 0 fail**.
- shell-core: **14 pass**.

---

## [9d3c847] refactor: review wave 3 — secp dedup + Cosmos Injective + mobile DS — 2026-05-16

### Added
- `packages/wallet-sdk/src/crypto/secp.ts` — single source for `toCompressedSecp256k1` / `toUncompressedSecp256k1`. 5 adapters (btc / xrp / evm / tron / cosmos) had identical local helpers — now all import the shared module.
- `CosmosAdapter.evmAddressing` option — Injective / Ethermint family. keccak256 address derivation (same 20 bytes as EVM), `inj` bech32 prefix, `/injective.crypto.v1beta1.ethsecp256k1.PubKey` Any typeUrl.
- New test: same seed yields `inj1...` 20-byte address ≡ EVM `0x...` 20-byte.

### Changed
- `apps/mobile` adopts `@byeorin/design-system` — `tokens.color` / `space` / `radius` / `font`. 6 hardcoded hex literals replaced.
- Korean font stack added (System → Apple SD Gothic Neo / Noto Sans CJK).
- Dark chrome colors retained at v0.1 (DS exposes light palette only for now).

### Test metrics
- SDK: **59 pass / 9 skipped / 0 fail** (3 new Injective tests).

---

## [72887dc] refactor: review wave 2 — ChainAdapter signRequests[] + @byeorin/shell-core — 2026-05-16

### Added
- `@byeorin/shell-core` package — `WalletStore` + `SessionStore` interface. Eliminates wallet-store.ts duplication across 4 shells (web / desktop / mobile / extension).
- `WebSessionStore` (autoRestoreAllowed=false, v0.1 in-memory only — H1 security policy).
- `ExtensionSessionStore` (`chrome.storage.session`, autoRestoreAllowed=true).
- `MemorySessionStore` (mobile default).
- `SignRequest` interface — `{ message: Uint8Array, prehashed: boolean }`. HW-signer hint.
- New test: BTC multi-input signing now works through the public `Wallet.transfer` API.

### Changed
- **`ChainAdapter` interface migration**: `serializeForSigning` / `applySignature` → `signRequests[]` / `applySignatures[]`. All 9 adapters migrated (evm / btc / xrp / cosmos / solana / tron / ton / aptos / sui). Single-signature chains return exactly one request; BTC returns one per input.
- `BtcAdapter` side channel `signingDigests` made `private` (was inadvertently public).
- Hangul regex tightened `[가-힯]` → `[가-힣]` (M3).

### Test metrics
- SDK: **56 pass / 9 skipped / 0 fail** (1 new BTC multi-input test).
- 8 packages typecheck pass.

---

## [1ec8e5b] fix: review wave 1 — security + UX + cleanups — 2026-05-16

### Added
- Extension EIP-1193: per-origin consent flow + connect popup + EIP-6963 announce + scope restricted to `https://` and `localhost` (C1 + H2 + H3).
- Desktop Wallet: triple-state balance UI (loading / error / success) + "retry" button (M1).
- Web / Desktop: `@byeorin/design-system` adoption (Logo / Button / Card / Input / AddressDisplay / AmountDisplay).
- Firmware APDU: APDU_ERR_BAD_LC error code (M5).

### Changed
- Web Send: `viem.parseUnits` replaces float math (C2 — precision bug).
- SDK: `xrpToDrops` adds safe-range guard, rejects negatives, defends against scientific notation (M6).
- SDK: `isValidClassicAddress` re-export moved to `index.ts` (removes tsup warning).
- Firmware APDU parser: handles both short and extended forms.

---

## [8419a53] feat: parallel wave 2 — P2 adapters + HW spec + firmware skeleton — 2026-05-15

### Added
- **`TonAdapter`** — `@ton/ton` v4 wallet, EQ-bounceable addresses, inline-action serialization (ESM-safe).
- **`AptosAdapter`** — Petra derivation path `m/44'/637'/i'/0'/i'`, sha3-256 auth key.
- **`SuiAdapter`** — blake2b-256 address, intent-prefixed signing, base64 `flag ‖ sig ‖ pubkey`.
- `hardware/SPEC.md` (11 sections), `BOM.csv` (39 rows, target ~$35 at 1k), `pin-map.md`, `threat-model.md`.
- `firmware/` Zephyr skeleton (35 files): nRF52840 + SE050 (I2C) + e-ink (SPI3), Ledger-compatible APDU framing, MCUBoot bootloader plan, chain apps (evm / cosmos / btc).

### Test metrics
- SDK: **55 pass / 9 skipped (live) / 0 fail** across **9 chains** (EVM + TTL, BTC, XRP, Cosmos, Solana, TRON, TON, Aptos, Sui).

---

## [6474c9c] feat: parallel wave — SW shells x4 + P0/P1 adapters + design system — 2026-05-15

### Added
- `apps/web` — Vite + React. Wallet generate / recover / balance / transfer against live TTL RPC.
- `apps/extension` — **WXT** (MV3), EIP-1193 provider, popup.
- `apps/desktop` — **Tauri 2** + React, `src-tauri/` Rust scaffold (Rust toolchain not required at this stage).
- `apps/mobile` — **React Native 0.76 Bare** TypeScript, monorepo metro config.
- `packages/design-system` — `@byeorin/design-system`. tokens.css + Logo / Button / Card / Input / AddressDisplay / AmountDisplay.
- `BtcAdapter` — BIP-84 p2wpkh + Esplora, multi-input signing.
- `XrpAdapter` — xrpl v4, half-SHA-512, DER re-encoding.
- `CosmosAdapter` — cosmoshub-4 / osmosis-1 / etc., hand-rolled `TxRaw`.
- `SolanaAdapter` (P1) — Phantom path `m/44'/501'/i'/0'`.
- `TronAdapter` (P1) — tronweb v6 base58check.

### Test metrics
- SDK: **40 pass / 6 skipped (live) / 0 fail**.
- All builds pass: web / extension / desktop / design-system / wallet-sdk.

---

## [05f00a1] init: monorepo + @byeorin/wallet-sdk with EVM/TTL working — 2026-05-15

### Added
- pnpm + turbo monorepo bootstrap.
- `@byeorin/wallet-sdk` initial scaffold: `Wallet.fromMnemonic` → `Wallet.account(adapter)` → `Wallet.transfer(account, intent)` flow.
- `EvmAdapter` working against TTL (chain 7777) via viem.
- `SoftSigner` (secp256k1 / ed25519, 65-byte `r‖s‖recovery` blob for secp).
- BIP-39 (English wordlist) + BIP-32 + SLIP-0010.
- `TTL_CHAIN` + `EVM_CHAINS` (Ethereum / Polygon / BSC / Arbitrum / Optimism / Base / Avalanche).
