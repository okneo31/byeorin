# v0.5.23 — 모든 자산을 TTL 로 잰다

작성 시점 실측 기준. 이 문서의 모든 환산 예시는 **`rate-snapshot.json` 의
`anchoredAt: 2026-07-29` 앵커 기준**이다. 값은 고정이 아니다 — 스냅샷을 다시
만들면 66 종이 전부 바뀌고 아래 숫자도 전부 바뀐다.

---

## 1. 결론

- **모든 자산이 TTL 로 재어진다 — 맞음.** 상장자산(BTC·ETH·SOL·TRX·TON·APT·SUI·
  XRP…)의 주 표시가 USD 에서 TTL 로 바뀌었다. 셸 4 종에 남아 있던 USD 보조줄은
  `tokens.value_usd` 사용처 0 건으로 소멸했다.
- **TTL 자신은 환산되지 않는다 — 맞음.** `assetValueInTtl` 의 `'ttl'` 분기는
  곱셈 0 회로 즉시 반환하고, `AssetRef` 의 `'ttl'` 갈래에는 `symbol` 필드가 없어
  시세표에 넘길 인자가 타입 수준에서 없다.
- **환율 상수 0 건.** 제품 코드(셸 4 종 + SDK 값 경로)에 환율 숫자 리터럴이 없다.
- 산출물 v0.5.23 / versionCode 24: APK · Chrome MV3 · MSI · NSIS · web dist.
- **미해결 결함 1 건 (§9-1).** android 포트폴리오 합계가 ZION 4 종 자산을 빼고
  세며, 뺀 사실을 드러내지도 않는다. extension 은 넣는다. 같은 잔액에서 두 셸의
  합계가 다르다.

---

## 2. 환산 표 (전부 2026-07-29 앵커 기준)

| 자산 종류 | `basis` | 계산식 | 예시 (2026-07-29 앵커 기준) |
|---|---|---|---|
| TTL 자신 | `self` | 곱셈 0 회. `노동자 N 일 품삯` | TTL 1 → 1 TTL, `volatile:false` |
| t{ISO} 통화토큰 | `byeorin-rate` | 수량 ÷ `rateByAddress(addr).perTtl` | tKRW 1000 ÷ 141180.04441511573 = 0.00708315402607 TTL |
| 스테이블코인 | `face` | 수량 × 액면(그 통화) ÷ `rateByIso(액면).perTtl` | USDT 100 ÷ 246.64798986458746 = 0.405436103715668 TTL |
| 상장자산 | `market` | 수량 × USD 시세 ÷ `rateByIso('USD').perTtl` | BTC 1 × 63,412 ÷ 246.64798986458746 = 257.09514208818 TTL |
| 신원 미확인 토큰 | — | 계산하지 않음 | `ttl:null`, `reason:'unverified'` |
| 시세·액면 없음 | — | 계산하지 않음 | `ttl:null`, `reason:'unlisted'` |
| 스냅샷에 통화 없음 | — | 계산하지 않음 | `ttl:null`, `reason:'no-face-rate'` |

산식은 `packages/wallet-sdk/src/rates/value.ts:143 assetValueInTtl` 한 곳뿐이다.
셸 4 종은 부르기만 한다. v0.5.21 에 셸마다 짜서 4 벌이 어긋났고 v0.5.22 를 그
수습에 썼다.

---

## 3. 환율이 상수가 아님을 어떻게 보장했나

**(1) 주입 구조 — 모듈 로드, 인자 아님.**
`rates/index.ts` 가 `RATE_SNAPSHOT` 을 정적 import 하고 색인을 1 회 만든다.
`assetValueInTtl` 은 `rateByAddress`/`rateByIso` 만 호출한다. 셸이 rate 를 넣을
자리가 없다 — 주입 지점은 `ctx.prices`(시세표) 하나뿐이고 **옵셔널이 아니다.**
시세표가 없으면 `null` 을 명시적으로 넘겨야 해서 "인자 만들고 배선 안 함"이
타입에서 막힌다.

**(2) 2 배 실험 (검증 부대 실행, 원복 확인됨).**
`rates/snapshot.ts` 의 tUSD `perTtl` 을 246.64798986458746 → 493.29597972917492
로 임시 치환:

| 자산 | 치환 전 | 치환 후 | 비율 |
|---|---|---|---|
| BTC 1 (63,412 USD) | 257.0951420881796 | 128.5475710440898 | 정확히 1/2 |
| USDT 100 | 0.40543610371566835 | 0.20271805185783418 | 정확히 1/2 |
| tKRW 1000 | 0.007083154026072349 | 불변 | KRW perTtl 미변경 — 정상 |
| TTL 1 | 1 | 1 | 불변 |

원복은 `git status --porcelain packages/wallet-sdk/src/rates/snapshot.ts` 출력
0 줄로 확인했다.

**(3) 상수 색출 (이 보고 시점 재실행).**
`grep -rnE "246\.6|0\.0040[0-9]|141180"` — 제품 코드 매치 0 건. 잔존 5 건은 전부
비제품이다:
- 주석 2 건 — `rates/index.ts:121`, `rates/value.ts:44` (옛 예시 숫자. 재앵커 시
  거짓이 된다 — §9-4)
- 테스트 픽스처 3 건 — `asset-value.test.ts:242`(정규식 설명 주석),
  `stable-denom.test.ts:19`, `token-identity.test.ts:13`
- 생성물 `rates/snapshot.ts` (앵커 원본이므로 정상)

**(4) 테스트로 고정.** `rates/{value,market,stable,index}.ts` 4 파일에 대해 주석
제거 후 `\d+\.\d{3,}` 과 4 자리 이상 정수 리터럴이 0 건임을 테스트가 지킨다.
`vi.mock('../src/rates/snapshot.js')` 로 가짜 앵커를 넣어 "스냅샷을 바꾸면 결과가
따라 바뀐다"를 고정했다(테스트 파일 3 벌: 진짜 앵커 / 가짜 앵커 / USD 없는 앵커.
모의가 파일 단위라 한 파일에 섞으면 둘 중 하나가 거짓이 된다).

**재앵커하면 무엇이 바뀌나.** `node scripts/build-rate-snapshot.mjs` 재실행 →
66 종 `perTtl` 전부 새 값, `anchoredAt` 갱신. 화면의 TTL 값이 전부 따라 바뀌고,
화면에 표시되는 앵커 날짜도 따라 바뀐다. 코드 수정은 0 건이다.

---

## 4. 왜 옛 페그로의 회귀가 아닌가

옛 페그는 `TTL = 10/365 BTC` — **TTL 자신의 값이 시장을 따라갔다.** 이번 것은
방향이 반대다: **BTC 를 TTL 이라는 자로 잰다.** 재어지는 쪽이 시장 자산이고,
자의 눈금(perTtl = 명목GDP ÷ 인구 ÷ 365)은 시장을 입력으로 쓰지 않는다.

TTL 잔액에 시세가 곱해지지 않음을 3 겹으로 막았고, 그중 2 겹은 테스트로 고정했다:

1. **타입** — `AssetRef` 의 `'ttl'` 갈래에 `symbol` 이 없다(`value.ts:79`).
2. **분기** — `value.ts:150` 이 즉시 반환한다. 그 아래로 `ctx.prices` 가
   등장하는 곳은 `marketValue` 안뿐이다.
3. **시세 조회** — `symbolUnitUsd` 가 `TTL`·`WTTL` 을 각각 null 로 막는다.

실행 검증: `prices={TTLUSDT:'99999', WTTLUSDT:'99999'}` 를 주입해도 TTL 1 은
`{ttl:1, basis:'self', volatile:false}` 로 동일했다.

이번 라운드에 테스트가 실제로 잡아낸 구멍 1 건: `symbolUnitUsd` 가 표에
`WTTLUSDT` 페어가 있으면 WTTL 에 시세를 붙였다. 조회보다 먼저 차단하도록
`market.ts` 를 고쳤다.

---

## 5. 화면별 표시

**고정 액면 vs 시세 기준.** 색·아이콘이 아니라 **텍스트 배지 + 마커 문자**로
가른다(extension popup 360px·고대비 모드에서 색 구분이 사라지기 때문).

| basis | 키 | 배지 | 마커 |
|---|---|---|---|
| `self` | `tokens.value_labor_days` | 없음 | — |
| `byeorin-rate` / `face` | `tokens.value_ttl` | `tokens.basis_fixed`(고정 액면) | `=` |
| `market` | `tokens.value_ttl_market` | `tokens.basis_market`(시세 기준) | `~` |

값 미상은 빈칸이 아니라 문장이다 — `reason` 4 종이 각각
`value_unverified` / `value_unlisted` / `value_no_face_rate` / `value_bad_decimals`
로 간다. 빈칸은 0 으로 읽히므로 금지했다.

**앵커 표시.** 4 종 전부에 있다(런타임 `rateSnapshot().anchoredAt` 조회 — 날짜
리터럴 0 건): android `App.tsx:1644`·`TokenListPane.tsx:248`, extension
`App.tsx:320`·`TokenListPane.tsx:243`, desktop `Wallet.tsx:376`, web
`Account.tsx:278`. 확장 근거 패널에는 `basis_market_unit`(unitUsd·via) 줄과
`basis_anchored_at` 줄이 들어간다.

**포트폴리오 합계.** `sumTtl` 하나가 합계와 **값 미상 건수**를 함께 낸다.
`?? 0` 폴백은 4 종 어디에도 없다(grep 0 건). 값 미상은
`portfolio.total_excluded` 로 드러내고, 시세 항목이 섞이면
`portfolio.total_volatile_note` 로 몇 건인지 적는다.

i18n 신규 키 15 종을 ko·en 동일 집합으로 넣었다. 키 파리티: ko 615 / en 615 /
차집합 양방향 0.

---

## 6. 문서 개정

`docs/CONTEXT.md` §5 — **유지**: BTC 페깅 해제 문단, "TTL 잔액을 환산하지
않는다", "벼린 환율은 시장환율을 입력으로 쓰지 않는다", "두 앵커는 만나지
않는다"(이미 앵커/측정으로 분리 서술돼 있어 재작성 불필요).
**변경**: "모든 자산을 TTL 로 잰다" 항목에서 계수 상수 2 개(`0.00405436`,
`246.64798986458746`)를 제거하고 런타임 `rateByIso('USD')` 조회 서술로 교체.

금지선 2 개로 분리·신설:
- **(a) TTL 잔액에 어떤 시세도 곱하지 않는다.** (기존, 타입 차단 근거 추가)
- **(b) 환율을 코드에 상수로 박지 않는다.** (신설) 하위 규칙 4 개 — ① 런타임
  스냅샷 조회 ② 못 읽거나 통화 없으면 **비운다**(옛 값 폴백 금지) ③ `anchoredAt`
  고지 ④ 테스트로 고정.

`docs/RATES.md` — §2.2 "환율은 상수가 아니다" 절 신설. 부수 사실 오류 정정:
65종→66종(4 곳), "1종 미해결"→0 건, `tAED` 는 GDP·인구 둘 다 2024,
"스냅샷에 생성 시각이 없다"→`anchoredAt` 존재(날짜까지). §7 API 표에 실제
export 8 종 추가.

---

## 7. 검증 수치

**손계산 대조** (2026-07-29 앵커 기준, 전부 일치):
- USDT 100 = 100 ÷ 246.64798986458746 = 0.405436103715668 ✔
- BTC 1 = 63,412 ÷ 246.64798986458746 = 257.09514208818 ✔
  (`market.usdPerTtl` 0.004054361037156683 = 1/perTtl ✔)
- tKRW 1000 = 1000 ÷ 141180.04441511573 = 0.00708315402607 ✔

**경계 회귀** (임시 vitest 로 직접 실행 후 삭제):
- 가짜 USDT(0x1111…, 심볼 USDT, chainId 1) → `null` / `unverified` ✔
  (v0.5.20 에서 막은 구멍이 닫힌 채 있다 — 심볼 문자열 판정 없음)
- 진짜 USDT 대소문자 3 변형 → 동일값 ✔
- 앞뒤 공백·U+200B 삽입 주소 4 변형 → 전부 `null`/`unverified` ✔
- 진짜 USDT + 잘못된 chainId(56) → `null`/`unverified` ✔
- `prices=null` 인 BTC → `null`/`unlisted`, `sumTtl().missing = 1` (0 아님) ✔

**배선 누락 0 건.** `TokenListPane` 2 곳 모두 `prices`·`chainId` 를 필수 인자로
받아 전달한다. 옵셔널로 두면 배선 누락이 타입을 통과하므로 필수로 올렸다.

**4 종 일관성 — 부분 달성.** 값 자체는 같다(android식·extension식 호출이
tAED 1e18 → 0.0019769324468747133 로 동일). 그러나 **포트폴리오 합계 구성이
android 와 extension 에서 다르다** — §9-1.

**전체 빌드·테스트 (이 보고 시점 직접 재실행, 파이프로 종료 코드 가리지 않음):**
- `pnpm -r build` EXIT=0
- `pnpm -r test` EXIT=0 — wallet-sdk 758 통과 · 10 skip(47 파일) / extension 119
  (6 파일) / shell-core 95(3 파일) / i18n 19(1 파일). 실패 0.
- 기준선 대비: wallet-sdk 722 → 758 (+36 신규), extension 118 → 119 (+1)

---

## 8. 산출물

| 산출물 | 크기 (B) | sha256 |
|---|---|---|
| `벼린0.5.23.apk` | 5,603,112 | `b4f9dfe321caee81703cd099474e1621b49560a560d68b6306e89c76c8129d01` |
| `벼린_0.5.23_x64_ko-KR.msi` | 8,237,056 | `f4c329dc3c7bb6ea66493b859f3a071d49d5315e22ce229208024777c5aac843` |
| `벼린_0.5.23_x64-setup.exe` | 7,255,962 | `6386306c1482f07c2ab57a212c7af1e50425cfdc6876afaf82e5027cb47cb200` |
| chrome-mv3 (extension) | 7,119,759 | — (디렉터리) |

- APK 크기 증분: 5,599,680 → 5,603,112 = **+3,432 B (+0.061%)**
- **서명 동일 키 — 맞음.** certSha256 `303f801b…f103480`, 지정값과 일치. 키스토어는
  기존 것을 썼고 새로 만들지 않았다.
- **QR 회귀 없음 — 맞음.** `shell-core` 95 통과(qr-parse 34 / store 44 /
  keystore 17), 기준선과 동일. 카메라 스캔 실기기 검증은 하지 않았다.
- **workingTreeClean = false.** 매니페스트에 경고 문구가 삽입돼 있다 — 미커밋
  트리 빌드라 이 산출물은 커밋으로 추적되지 않는다. commit 기록값은
  `6529912`(빌드 시점 HEAD)다.

---

## 9. 남은 것

**1. [심각·미해결] android 포트폴리오 합계가 ZION 4 종 자산을 조용히 뺀다.**
- `apps/android/src/App.tsx:1217` — `visibleTokens` 에서 ZION 자산을 제외한다.
- `App.tsx:1263-1268` — `counted` 는 native + 잔액>0 토큰만. ZION 자산이 없다.
- `App.tsx:1656-1692` — 같은 화면 아래에서 ZION BTC/USDT/ETH 를
  `assetValueInTtl` 로 재어 "≈ N TTL (시세 기준)" 으로 **표시한다.**

결과: cosmos:zion 에서 BTC 1 개를 들고 있으면 화면 하단에는 그 TTL 값이 뜨는데
바로 위 합계는 그것을 더하지도, `total_excluded` 로 세지도 않는다.
표시 원칙 3("빠진 것을 숨기고 합계를 내면 거짓이다") 위반이고, 값 미상이 아니라
**값을 아는 자산**을 숨기는 쪽이라 더 나쁘다.
extension `App.tsx:1296-1300` 은 `parts.push(...zionValues)` 로 옳게 처리하며
ZION 일 때 native 를 빼 이중계상도 막는다. 즉 이번 라운드가 없애기로 한
"셸마다 갈라짐"이 합계 구성에서 재발했다.

**2. [경미] 합계 모집단 기준 불일치.** android 는 `balance > 0n` 자산만 세고,
extension 은 잔액 0 자산도 넣는다. 잔액 0 인 미확인 토큰이 extension 에서만
`total_excluded` 카운트를 올린다.

**3. [경미] desktop·web 은 `{prices: null}` 고정**(`Wallet.tsx:236,252`,
`Account.tsx:161,166`). 그 두 셸에 Binance fetch 경로가 없다. 시세 자산이 전부
`tokens.value_unlisted` 로 뜨는데, 사유가 "미상장"으로 읽혀 실제 원인(그 셸에
시세 경로 없음)과 어긋난다. 0 으로 보이지는 않으므로 거짓은 아니다.

**4. [경미] 주석 2 건에 옛 환율 예시 숫자 잔존** — `rates/index.ts:121`,
`rates/value.ts:44`. 제품 코드 상수는 아니나 재앵커 시 거짓이 된다.

**5. 시세 출처가 Binance 단일 의존이다.** 그 API 가 죽으면 상장자산 전 종목이
`unlisted` 로 비고, 값이 틀리게 뜨지는 않지만 화면이 비는 범위가 넓다.
대체 출처·다중화는 이번 범위 밖이다.

**6. 스냅샷 재앵커 주기·담당이 정해져 있지 않다.** 현재 `anchoredAt` 은
2026-07-29 이고 World Bank 데이터는 gdpYear 2024(대부분 2025)다. 누가 언제
`build-rate-snapshot.mjs` 를 돌리는지 규칙이 없다.

**7. DAI soft peg.** 액면 1 USD 로 다루지만 DAI 는 하드 페그가 아니다. 현재는
`face` 로 재어 `basis_fixed`("고정 액면") 배지가 붙는데, 실제로는 소폭 출렁인다.

**8. 실기기·브라우저 렌더 미검증.** 빌드·타입·테스트·소스 대조만 했다. APK 설치,
Tauri 실행, 확장 로드, 화면 실동작은 확인하지 않았다.

**9. 미완 부채 (이번 라운드에 못 지운 것).** SDK 의 `tokenValueOf`·`stableToTtl`·
`tokenAmountToTtl`·`stableAmountToTtl` 이 `/evm` 배럴에 `@deprecated` 로 남아
있다. 셸 호출부는 0 건이 되었다(잔존 grep 매치 5 건은 전부 주석). 루트 배럴에는
처음부터 넣지 않았다. export 삭제는 다음 라운드다.

**10. 스왑 견적·송금 확인 화면의 TTL 줄 미적용** (명세 3.5·3.6). 해당 파일들이
이번 소유 범위 밖이었다.

---

## 10. 경로

**산출물**
- `D:/TTLCOINWalet/벼린0.5.23.apk` · `D:/TTLCOINWalet/벼린0.5.23.apk.manifest.json`
- `D:/TTLCOINWalet/apps/desktop/src-tauri/target/release/bundle/msi/벼린_0.5.23_x64_ko-KR.msi`
- `D:/TTLCOINWalet/apps/desktop/src-tauri/target/release/bundle/nsis/벼린_0.5.23_x64-setup.exe`
- `D:/TTLCOINWalet/apps/extension/.output/chrome-mv3/`
- `D:/TTLCOINWalet/apps/web/dist/`

**신규 소스**
- `D:/TTLCOINWalet/packages/wallet-sdk/src/rates/value.ts` (단일 환산 함수)
- `D:/TTLCOINWalet/packages/wallet-sdk/src/rates/market.ts`
- `D:/TTLCOINWalet/packages/wallet-sdk/src/rates/stable.ts`
- `D:/TTLCOINWalet/packages/wallet-sdk/tests/asset-value.test.ts`
- `D:/TTLCOINWalet/packages/wallet-sdk/tests/asset-value-snapshot.test.ts`
- `D:/TTLCOINWalet/packages/wallet-sdk/tests/asset-value-no-usd.test.ts`

**문서**
- `D:/TTLCOINWalet/docs/CONTEXT.md` · `D:/TTLCOINWalet/docs/RATES.md` ·
  `D:/TTLCOINWalet/docs/CHANGELOG.md` · `D:/TTLCOINWalet/docs/RELEASE-0.5.23.md`

**임시파일**: `D:/TTLCOINWalet/scripts/ttl-out/` — 비어 있음(확인함). 커밋·푸시
하지 않았다.
