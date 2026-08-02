# BIP157 잔여 5건 라운드 — 마무리 보고서

작성 기준: 이 문서의 모든 수치는 보고서 작성 시점에 직접 실행한 출력이거나, 실행 부대의 출력 중 내가 재현 확인한 것이다. 재현하지 않은 것은 "부대 보고"라고 표기했다.

---

## 1. 결론

- **5건 중 4건 해소(R1·R2·R3·R4), 1건 부분 해소(R5).**
- R5 는 (a) 셸 T2 실기 · (b) testnet 삼각검증 두 갈래인데, 둘 다 실증은 되었고 **머클(D1) testnet 확인 1개만 미해소**로 남았다. 그래서 R5 전체는 "부분".
- 테스트 최종: `btc-bip157.test.ts 58 + btc-bip157-errors.test.ts 47 + btc-bip157-reorg.test.ts 13 + btc-bip157-remainder.test.ts 6 = 124/124 통과` (직접 실행, 4.00s).
  - 기준선 118 → 124. 증가분 6 = 신규 파일 1개(remainder). **기존 3파일은 0줄 변경** (`git diff aa25ecc -- packages/wallet-sdk/tests/btc-bip157-errors.test.ts` 빈 출력).
- typecheck `tsc --noEmit` EXIT=0. build(tsup) EXIT=0.
- 제품 코드 변경은 **1파일뿐**: `packages/wallet-sdk/src/btc-history/bip157/scan.ts` +156/−38 = 194줄. `messages.ts`·`gcs.ts`·`p2p.ts` 변경 0줄.

---

## 2. 항목별 표

| ID | 성격 | 파일:라인 | 조치 | 검증 방법 | 판정 |
|---|---|---|---|---|---|
| R1 | 수정 | scan.ts:209 | `handleChunk` 진입부 `if (this.closedErr) return` 1줄 | 가드 유무만 다른 복사본 2개를 동일 부하(cfilter 15,000통)로 실행 대조 | **해소** |
| R2 | 수정 | scan.ts:141–181, 274–284, 325, 호출부 6곳(340·352·450·517·546·624) | 단일 `MAX_QUEUE_BYTES`(64MiB) 제거 → 요청 단위 예산(`QueueBudget`/`blockBatchBudget`/`cfilterBudget`), `send` private 화 + `request(cmd,payload,budget)`, `blockBatchSize` 1..64 클램프 | batch 16/32/64 정직 대용량 완주 + 적대 3종 차단 실측, 실피어 5곳 교차 | **해소** |
| R3 | 수정 | scan.ts:389–395, 445 | `maxRounds` 를 "라운드당 2000" 가정에서 분리 → `ceil((headerSpan+4144)/16)+12` + 라운드 8 유예 후 생산성 바닥 | 200헤더/라운드 정직 피어 10라운드 완주(105ms), 1헤더/라운드 피어 유한 종료 | **해소** |
| R4 | 수정 | scan.ts:398–434(buildLocator), 463–481(무진전 판정) | 무진전 시 `topKnown` 판별 → 넓힘 1회차(구간 지수 locator) / 2회차(전체 표준) / 3회차 없음 | 깊이 8·16·64 재조직 모두 4라운드 회복, 악의 재생은 2라운드 종료 | **해소** |
| R5(a) | 실증 | apps/extension·web/src/lib/ws-tcp-transport.ts, apps/android/src/native-tcp.ts, apps/desktop/src/native-tcp.ts + src-tauri/src/tcp_bridge.rs | 코드 수정 없음 | 릴레이 왕복 실측(실피어 3곳 version→verack) + 재사용 버퍼 대조(OLD 실패/NEW 성공) | **해소** |
| R5(b) | 실증 | scripts/btc-p2p/testnet-scan.mjs | 코드 수정 없음, dist 재빌드 후 실행 | 실피어 6곳 × 8개 높이 전부 8/8 일치 | **해소** |
| R5(b′) | 실증 | messages.ts:484 `computeMerkleRoot` | — | **실행 불가** — testnet-scan.mjs 에 블록 본문 수신 경로 없음 | **미해소** |

### 안드로이드·데스크톱 전송 — "없음" 아님

4종 전부 실재한다(`git ls-files` 확인): extension / web / android(Capacitor `TcpSocketPlugin`) / desktop(Tauri 2 `tcp_bridge.rs`). android·desktop 은 base64 문자열을 경유해 이벤트마다 `new Uint8Array` 를 새로 할당하므로 재사용 버퍼가 **구조적으로 발생 불가**다. 그래서 T2 회귀 확인 목적의 에뮬레이터·Tauri 실행은 하지 않았다. 이는 소스 판독 판정이고 실기 실행 결과가 아니다.

---

## 3. R4 충돌 처리 — 적용했고, 테스트 단언은 1글자도 고치지 않았다

**충돌 판정: 충돌 없음. locator 를 넓히면서 `rounds <= 2` 를 지킬 수 있다.**

문제였던 단언: `packages/wallet-sdk/tests/btc-bip157-errors.test.ts:1007`
```
expect(rounds, `getheaders 를 ${rounds}회 반복 — 진행 없음 감지 실패`).toBeLessThanOrEqual(2);
```
직접 확인했다 — 이 줄은 원문 그대로 살아 있다(`git diff aa25ecc -- .../btc-bip157-errors.test.ts` 빈 출력).

### 왜 양립하는가

무진전 라운드의 헤더는 전부 우리 체인 위에 있다(모르는 헤더가 있었으면 `appendHeader` 가 이미 던진다). 그래서 그 응답에서 "우리가 아는 최대 높이" `topKnown` 이 항상 정의된다. 판별식은 추측이 아니라 정보량 질문이다.

- `topKnown >= tipHeight` → 피어가 **우리 tip 을 아는 지점부터** 답했다. locator 를 넓혀도 더 높은 공통 조상은 존재하지 않는다. 새 정보 0 ⇒ 즉시 예외.
- `topKnown < tipHeight` → 피어가 우리 최근 8개를 하나도 못 알아보고 훨씬 아래에서 답했다 = 갈림점이 locator 창(8) 밖 ⇒ 넓혀 재시도.

두 시나리오 실측 대입:

| 시나리오 | tip | 응답 topKnown | 분기 | 실측 getheaders |
|---|---|---|---|---|
| errors:1007 악의적 재생 | CP+2000 | CP+2000 (= tip) | 즉시 예외 | **2** (단언 통과) |
| reorg:846 깊은 재조직 | 4100 | 2100 (< tip) | 넓힘 2회 후 예외 | **5** ≤ maxGetheaders 6, forcedClose false |
| 독립 프로브: 악의 재생(startHeight 5,000,000, maxGetheaders 5000) | — | = tip | 즉시 예외 | **2**, 5ms |

즉 라운드가 늘어나는 것은 "깊은 재조직" 쪽뿐이고, "악의적 재생"은 늘지 않는다. **사람이 결정할 트레이드오프가 남지 않았다.**

평시 locator 모양도 건드리지 않았다 — `reorg.test.ts:611` 의 "정확히 9개(`끝 8 + 체크포인트`)" 단언이 그대로 통과한다. 넓힘은 `widenUsed >= 1` 일 때만 발동한다.

실물 캡처(독립 프로브, 높이 표기):
- 평시(widenUsed 0): `300,299,…,293,CP` = 9개, 간격 1
- 넓힘 1회차: `300,299,…,290,288,284,276,260,228,200,CP` = 18개 (앞 11개 간격 1, 이후 2·4·8·16·32 지수 back-off, 확인 하한 200 과 CP 로 마감)

회복 실측: 깊이 8·16·64 재조직 모두 **4라운드**에 회복, tip 310 정답, 예외 0, forcedClose false. 세 경우 모두 넓힘 1회차에서 성립했고 2회차는 밟히지 않았다.

관찰(결함 아님): 깊이 8(= 평시 locator 창 크기와 동일)에서도 평시 locator 로는 못 붙고 넓힘 1회를 소비한다. 비용은 라운드 1회이고 오답은 없다.

---

## 4. 테스트 — 118 → 124, 무결성 감사

직접 실행 출력:
```
✓ tests/btc-bip157.test.ts          (58 tests)   18ms
✓ tests/btc-bip157-reorg.test.ts    (13 tests)  590ms
✓ tests/btc-bip157-errors.test.ts   (47 tests) 1108ms
✓ tests/btc-bip157-remainder.test.ts (6 tests) 3400ms
Test Files 4 passed (4) / Tests 124 passed (124) / Duration 4.00s
```

무결성 감사:
- `git diff aa25ecc -- packages/wallet-sdk/tests/` → **빈 출력**. 기존 3파일 변경 0줄.
- skip / only / todo 추가 0건. 기대값을 구현에 맞춘 수정 0건.
- 증가분 6건은 신규 파일 `packages/wallet-sdk/tests/btc-bip157-remainder.test.ts`(untracked) 뿐이다.

신규 6건의 회귀 감지력 — **직접 대조 실행 결과**(scan.ts 를 aa25ecc 판으로 되돌려 remainder 단독 실행):
- **5건 실패 / 1건 통과.** 즉 R1·R2·R3·R4·"1헤더/라운드 대조" 5건은 진짜 회귀 감지력을 갖는다.
- 통과한 1건은 "악의적 재생 대조"이고, 이건 수정 전에도 통과하던 성질이라 회귀 가치가 없다. 숨기지 않는다.

R2 테스트 1건이 3,233ms 로 전체 시간을 지배한다(힙에 약 70MB 를 한 번에 올린다). CI 메모리 여유가 좁으면 이 한 건만 비용이 튄다.

---

## 5. 미검증 영역 실증 결과

### 5-1. R1 실측 (같은 코드베이스, 가드 한 줄만 제거한 복사본과 대조)

| | closeCount | 투입 | 상한 발동 | arrayBuffers Δ |
|---|---|---|---|---|
| 가드 없음 | 14,745 | 15,002통 | 257통째 | +0.5544 MiB |
| 가드 있음 | **2** | 15,002통 | 257통째 | +0.5138 MiB |

계산식: 가드 없음 = (15,000 − 256) + 1(finally) = 14,745. 가드 있음 = 1(오버플로) + 1(finally) = 2.
절감 = 14,743회, 감소율 = 1 − 2/14,745 = **99.986%**.

**기준값 정정**: 임무 지시문의 "12,952 / 15,000통, 2,049통째 발동"은 현행 코드에서 재현되지 않는다. R2 도입으로 헤더 대기 국면 예산이 `MIN_BUDGET_MESSAGES = 256`(scan.ts:155,166) 이라 큐가 2,048 이 아니라 **256** 에서 찬다. 12,952 = 15,000 − 2,048 은 R2 이전 기준값이다. 방어가 약해진 게 아니라 8배 빨리 끊긴다.

### 5-2. R2 실측 — 정직 완주 / 적대 차단

정직 대용량(블록당 3,900,000B × 64블록, 전부 watch 매칭):

| batch | 완주 | 큐 최고수위 | 예산 bytes | 옛 상한(67,108,864) 대비 |
|---|---|---|---|---|
| 16 | O | 62,404,192 B (59.5 MiB) | 67,200,000 | 아래(여유 4.70MB) |
| 32 | O | 124,808,384 B (119.0 MiB) | 134,400,000 | **1.86배 초과** |
| 64 | O | 249,616,768 B (238.1 MiB) | 268,800,000 | **3.72배 초과** |

세 경우 모두 tip 164 / records 64 / matched 64 / filters 64 / emptyMatchedBlockHeights []. **수정 전이라면 batch 32·64 는 정직한 피어에게 죽었다** — 이것이 R2 의 발현 조건이고, 지금은 완주한다.

적대 대조 3종 — 전부 예외로 차단:
1. 헤더 대기 중 비요청 3.9MB block: **4통 / 7.4MiB** 에서 차단, heapΔpeak 0.0MiB
2. 헤더 대기 중 비요청 64B cfilter 15,000통 시도: **259통**에서 차단, heapΔpeak 1.8MiB
3. 예산 최대(batch 64, 268.8MB) 국면에 비요청 3.9MB 블록 60통 끼워넣기: 265,217,816 B 에서 차단

차단 문턱(최악 상주)이 옛 64MiB → 268.8MB(batch 64)로 **4.0배** 커졌다. 기본값 16이면 67.2MB. 이건 사실이고 6절에 남긴다.

### 5-3. 실피어 회귀 (mainnet, dist 재빌드 후 = 수정 코드)

5피어 전원 `ok:true`, 기준값 6항목 전부 일치:

| peer | tipHeight | scannedFilterCount | matched | records | totalMs |
|---|---|---|---|---|---|
| 126.94.88.240 | 960450 | 300 | 2 | 4 | 1128 |
| 211.54.72.211 | 960450 | 300 | 2 | 4 | 781 |
| 174.31.125.203 | 960450 | 300 | 2 | 4 | 2391 |
| 106.51.20.106 | 960450 | 300 | 2 | 4 | 3048 |
| 69.181.198.153 | 960450 | 300 | 2 | 4 | 3673 |

tipHash `00000000000000000000408f69c0d7a6cc5e3725e0c34b0863c18912c8aebb3c` 5곳 동일, expectedFound 3, bytesIn 7,940,691 바이트 단위까지 동일.

성능: 정렬 [781, 1128, 2391, 3048, 3673] → 중앙값 **2,391ms**. 기준 2,488ms 대비 (2391−2488)/2488 = **−3.90%**. 회귀 없음. 단 connect 시간이 6~152ms 로 피어별 4.7배 산포라 ±4%는 잡음 범위다 — "빨라졌다"고 단정하지 않는다.

### 5-4. R5(a) 셸 T2 — 릴레이 왕복 + 재사용 버퍼 대조

Electrum 왕복: ws open 22ms / rtt 546ms / `["electrs-esplora 0.4.1","1.4"]` / OK.

실제 BTC p2p 왕복(셸 `WsTcpTransport` + 수정된 `P2PFrameDecoder`, version→verack):

| peer | agent | startHeight | handshake | ws chunks / bytes / msgs |
|---|---|---|---|---|
| 35.236.203.5 | /Satoshi:25.1.0/ | 960515 | 385ms | 2 / 150 / 2 |
| 172.97.250.80 | /Satoshi:22.0.0/ | 960515 | 602ms | 3 / 198 / 4 |
| 54.36.168.56 | /Satoshi:31.0.0/ | 960515 | 546ms | 2 / 198 / 4 |

chunk 수 < 메시지 수 = 한 chunk 안 다중 프레임, 그리고 chunk 걸침 모두 정확 조립. 체크섬 예외 0.

재사용 버퍼 대조(같은 스크래치 `Uint8Array` 재사용 + push 직후 0xff 덮어쓰기, ping 5통):
- OLD(복사 없음 모사): `p2p: bad magic — stream out of sync`, msgs=0
- NEW(현 코드 p2p.ts:107 `chunk.slice()`): err=null, msgs=5

즉 T2 는 실제로 방어 효과가 있는 코드이고, 저장소 내 전송 4종은 전부 새 할당이라 현재 발현은 0이다.

### 5-5. R5(b) testnet 삼각검증 — dist 재빌드 후 실행

dist 신선도 확인: `dist/btc-history.js` mtime 14:25 > `src/.../scan.ts` 14:22, dist 안에 closedErr 가드 3곳 · `MIN_AVG_BATCH`/`widenUsed` 9곳 · `blockBatchBudget`/`MIN_BUDGET_MESSAGES` 4곳 존재 확인.

**서로 다른 피어 6곳 × 8개 높이(0, 2, 3, 15007, 49291, 987876, 1263442, 1414221) 전부 8/8 일치, 불일치 0건.**

| peer | agent | 결과 |
|---|---|---|
| 135.180.99.74 | /Satoshi:31.99.0/ | 8/8 |
| 208.68.4.50 | /Satoshi:29.3.0/ | 8/8 |
| 208.68.4.71 | /Satoshi:30.3.0/ | 8/8 |
| 203.132.94.196 | — | 8/8 |
| 198.206.204.71 | — | 8/8 |
| 65.109.24.172 | — | 8/8 |

높이 1414221 의 빈 필터 `"00"` (N=0) 정상 처리, 49291 = N=10, 1263442 = N=3. cfilter 수신 143~299ms.

부수 관찰(코드 결함 아님): btcd 계열 피어(/btcd:0.23.2~0.24.0/)는 service bit `0x40`(NODE_COMPACT_FILTERS)을 광고하고도 getcfheaders/getcfilters 에 무응답이다. 런2에서 0x40 광고 13곳 중 btcd 계열 전부 무응답. 피어 선택 시 광고 비트만 믿으면 타임아웃 비용이 든다. 그리고 141.98.219.198 은 6번째 요청 후 PEER_CLOSED — 정직한 피어도 중도 절단한다.

---

## 6. 남은 것 — 못 한 것과 신규 발견

### 6-1. 미해소 1건

**머클(D1) 검증의 testnet 동작 — 모른다.** `scripts/btc-p2p/testnet-scan.mjs` 에는 `merkle`/`getdata`/`MSG_BLOCK`/`'block'` 문자열이 하나도 없다. 블록 본문을 받는 경로가 없으므로 이 스크립트로는 확인 불가다. `e2e-scan.mjs` 에는 testnet 옵션이 없다. **저장소의 어떤 기존 명령으로도 이 항목을 돌릴 수 없다.** mainnet 에서 통과했으니 testnet 도 통과할 것이라는 추론은 하지 않는다 — testnet 은 코인베이스 전용 블록 비율이 달라 홀수/단일 노드 경로를 훨씬 자주 밟는다.

필요한 것: `scripts/remainder-out/testnet-merkle.mjs` 신규 작성. 노려야 할 경계 3가지 — (i) tx 1개짜리 코인베이스 전용 블록(root == txid), (ii) segwit witness commitment 블록(txid 는 witness 제외 직렬화), (iii) tx 홀수 블록(마지막 노드 복제가 CVE-2012-2459 검사와 충돌 안 하는지).

### 6-2. 이번 수정이 만든 것 — 심각 0, 주의 2건

**(1) 통수 예산이 사실상 상수 256 이다.** `scan.ts:152` `clampBudget` 의 `MIN_BUDGET_MESSAGES = 256` 하한 때문에 `HEADER_BUDGET.msgs = 64`(scan.ts:161)와 `IDLE_BUDGET.msgs = 256`(scan.ts:160), `blockBatchBudget` 의 `2B+16` 식(B ≤ 120 구간 전체)이 모두 256 으로 평탄해진다. 실측: batch 1·16·32·64 전부 `msgs: 256`. 실제 방어는 bytes 만 한다.
- 왜 그렇게 됐나: 설계대로 `blockBatchBudget(1).msgs = 18` 을 적용하니 `btc-bip157-errors.test.ts:1045`("요청 안 한 블록 200통 → 타임아웃")가 오버플로 예외로 바뀌어 실패했다. 설계가 명시한 원칙 — **테스트 기대값이 아니라 예산 상수를 고친다** — 에 따라 하한을 넣었다.
- 오답은 만들지 않는다(적대적 축적은 bytes 로 끊긴다는 것을 5-2 에서 실측). 다만 **코드가 표현하는 정책과 실제 동작이 다르다.**

**(2) 큐 메모리 천장 4.0배 증가.** `scan.ts:144` `MAX_QUEUE_BYTES_HARD = 268,800,000`. `blockBatchSize` 를 64로 올리면 적대적 피어가 끊기기 전 실제로 265MB 를 큐에 올릴 수 있음을 실측했다(5-2 항목 3). 기본값 16이면 67.2MB. 요청자가 스스로 고른 값이고 `ScanOptions` JSDoc(scan.ts:89–91)에 메모리 계약이 적혀 있으나, MV3 확장·모바일 셸에 이 값을 노출하면 OOM 경로가 된다.

### 6-3. 이번 수정 이전부터 있던 것 (회귀 아님, 이번에 발견)

**(3) chain 배열 자체에 상한이 없다.** `scan.ts:391` `maxAppends` 는 `maxRounds` 계산에만 쓰인다. 피어가 `remote.startHeight`(자기 주장, int32)를 크게 부르면 `maxRounds` 가 1e8 급이 되고, 라운드당 16헤더 이상만 계속 대면 생산성 바닥도 통과하므로 chain 이 메모리 한계까지 자란다. 구 코드(`expectedRounds*2+8`)도 같은 성질이라 회귀는 아니다. PoW/누적난이도 미검증(scan.ts:14–17 에 명시된 의도적 한계)과 같은 뿌리다.

**(4) 블록 수신 루프에 단계 데드라인이 없다.** `scan.ts:635–641` 에서 요청 밖 블록은 `continue` 로 무시만 한다. `next()` 타임아웃은 호출마다 초기화되므로, 피어가 타임아웃 직전마다 쓰레기 블록 1통씩 흘리면 루프가 무한히 지속된다. 큐 예산으로는 안 잡힌다 — 즉시 소비되기 때문이다. 구 코드와 동일.

**(5) 실피어 스크립트 신뢰성.** 첫 시도에서 2피어가 `run.mjs` 프로세스 예외로 죽어 결과 파일을 못 남겼다. `scripts/bip157-live/run.mjs:9` 주석은 "실패해도 ok:false 로 반드시 쓴다"고 하는데 그 경로에서는 파일이 없었다. 스택을 캡처하지 못해 원인은 모른다.

### 6-4. 못 한 것 (숨기지 않음)

- 안드로이드 실기기/에뮬레이터, Tauri 데스크톱 빌드에서의 실제 왕복 — 실행하지 않았다. 소스상 버퍼 신규 할당만 확인했다.
- 실피어로 "대용량 배치가 큐를 채우는" 상황 — 재현 못 했다. mainnet fixture 는 300블록 구간에 매칭이 2개라 getdata 배치가 2통이다. 5-2 의 대용량 수치는 전부 모의 피어 기반이다.
- R4 넓힘 locator 의 항목 구성 단언 — 신규 테스트는 "getheadersCount ≤ 6 안에 회복"만 단언한다. 넓힘 로직이 퇴화해 "전체 표준 locator 즉시 사용"으로 바뀌어도 통과한다.
- 개별 118건이 "이전과 동일한 118건"인지 테스트 이름 대조 — 하지 않았다. 파일 3개가 전부 pass 이고 전체 실패 0 인 것만 확인했다.

---

## 7. 산출물·임시파일 경로

**커밋 대상(아직 커밋 안 함, 지시 없음):**
- `D:/TTLCOINWalet/packages/wallet-sdk/src/btc-history/bip157/scan.ts` (수정, +156/−38)
- `D:/TTLCOINWalet/packages/wallet-sdk/tests/btc-bip157-remainder.test.ts` (신규, untracked)
- `D:/TTLCOINWalet/docs/BIP157-REMAINDER-ROUND.md` (이 문서)

**임시파일 — 삭제 대상 (지시대로 지우지 않음). `scripts/remainder-out/` 아래 전부:**
```
scripts/remainder-out/testnet-run.log
scripts/remainder-out/testnet-run2.log
scripts/remainder-out/testnet-vectors.json
scripts/remainder-out/testnet-vectors2.json
scripts/remainder-out/live12/{106.51.20.106,126.94.88.240,174.31.125.203,211.54.72.211,69.181.198.153}.json
scripts/remainder-out/r1/{r1-measure.test.ts,scan-before.ts,scan-after.ts,vitest.config.ts}
scripts/remainder-out/verify10/{r2.test.ts,vitest.config.ts,run-batch.mjs,live-b48.json,live-b64.json}
```
삭제 명령: `Remove-Item -Recurse -Force D:/TTLCOINWalet/scripts/remainder-out`

**범위 밖 미추적 파일 2개 (내가 만들지 않았고 건드리지 않았다):**
- `D:/TTLCOINWalet/docs/opus5.md`
- `D:/TTLCOINWalet/docs/JustLedger_정직한장부.md`

**dist:** `packages/wallet-sdk/dist/` 는 재빌드했다(gitignore 대상).
