# BIP157/158 라이트클라이언트 실피어 실측 보고서

작성일: 2026-08-01. 대상: `packages/wallet-sdk/dist/btc-history.js` 의 `bip157Scan` — 비트코인 메인넷 P2P(8333) 실피어 10곳 병렬 스캔.

## 1. 결론

**맞음.** 10개 피어 전원(10/10) 스캔 성공, records 정규화 집합·tipHash·기대 txid 3건 발견이 전 run 에서 완전 동일. 불일치 0건.

## 2. 방법

1. **발굴** (`discover.mjs`): DNS seed 해석 108개 → TCP+version 핸드셰이크로 도달 가능 40개 확정 (`out/peers.json` 40 항목, DNS 소요 3,781 ms).
2. **부트스트랩** (`bootstrap.mjs`): 헤더 동기화 genesis→tip 960,450 헤더 / 38,552 ms (피어 126.94.88.240 단일). 체크포인트 filterHeader 는 **13/13 피어 쿼럼** 일치로 확정. ground-truth 블록 960300(6,058 tx)에서 P2WPKH watchScript 3개 추출, cfilter 교차확인 `gcsMatchAny = true` (filterHash `534adf86…f875364a`).
3. **10부대 병렬 스캔** (`run.mjs` × 10): 서로 다른 피어에 `bip157Scan(transport, opts)` 실행 → `out/result-0..9.json`.
4. **교차검증** (`verify-cross.mjs`): 10개 결과 파일의 records·tip·expected 를 파일 실측으로 대조.

스캔 구간 계산식: stopAtHeight − checkpointHeight = 960,450 − 960,150 = **300 블록** — 전 run 의 scannedFilterCount = 300 과 일치.

체크포인트: height 960,150 / blockHash `00000000000000000001c52969b436512d0415a9bc46bc15a4b2f564af602c2d` / filterHeader `1204805c…415426bf`.
tip: 960,450 = `00000000000000000000408f69c0d7a6cc5e3725e0c34b0863c18912c8aebb3c`.

## 3. 피어별 실측 표

| run | host | connectMs | totalMs | bytesIn | bytesOut | scannedFilterCount | matchedBlockCount | recordCount | 시도 횟수 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 126.94.88.240 | 38 | 1,833 | 7,935,426 | 500 | 300 | 2 | 4 | 1 |
| 1 | 106.51.20.106 | 126 | 3,169 | 7,935,426 | 500 | 300 | 2 | 4 | 1 |
| 2 | 174.31.125.203 | 136 | 2,444 | 7,935,426 | 500 | 300 | 2 | 4 | 1 |
| 3 | 69.181.198.153 | 156 | 3,807 | 7,935,426 | 500 | 300 | 2 | 4 | 1 |
| 4 | 211.54.72.211 | 6 | 1,143 | 7,935,426 | 500 | 300 | 2 | 4 | 1 |
| 5 | 153.92.38.89 | 288 | 4,632 | 7,935,426 | 500 | 300 | 2 | 4 | 2 |
| 6 | 101.0.96.62 | 201 | 4,496 | 7,935,441 | 500 | 300 | 2 | 4 | 1 |
| 7 | 67.82.77.110 | 203 | 3,819 | 7,935,426 | 500 | 300 | 2 | 4 | 1 |
| 8 | 92.27.11.83 | 286 | 73,884 | 7,935,453 | 500 | 300 | 2 | 4 | 1 |
| 9 | 82.67.102.15 | 214 | 3,467 | 7,935,426 | 500 | 300 | 2 | 4 | 1 |

실패 피어: run-5 의 첫 시도 대상 **69.234.58.210 접속 실패 1건** → 대체 피어 153.92.38.89 로 2번째 시도에서 성공. 최종 실패 run 0개.

## 4. 집계

- **성공률 (run 기준)** = 성공 10 ÷ 시도 10 = **100%**.
- **성공률 (피어 접속 시도 기준)** = 성공 10 ÷ 접속 시도 11 (= 1×9 + 2×1) = **90.9%**.
- **totalMs**: 중앙값 3,637 ms (= (3,467 + 3,807) ÷ 2), 최소 1,143 ms (211.54.72.211), 최대 73,884 ms (92.27.11.83).
- **수신 바이트 합계** (cfheaders + cfilter 300개 + 매칭 블록 2개 포함) = 7,935,426×8 + 7,935,441 + 7,935,453 = **79,354,302 bytes**. 송신 합계 = 500×10 = 5,000 bytes.
- run 당 수신 ≈ 7.94 MB — 매칭 블록 960300 이 6,058 tx 대형 블록이라 블록 본문이 대부분을 차지.

## 5. 검증 결과 (verify-cross.mjs, 파일 실측 — 본 보고서 작성 시 재실측으로 재확인)

| 항목 | 판정 |
|---|---|
| 10/10 run `ok=true` | 통과 |
| records 정규화 집합(height·txid·receivedOutputs·spentOutpoints) 10개 run 완전 동일 | 통과 |
| tipHeight 960,450 = stopAtHeight, tipHash `…c8aebb3c` = fixture.meta.tipHash, 10/10 동일 | 통과 |
| fixture.expected txid 3건 전부 전 run records 존재, 높이 960300 일치 | 통과 |
| scannedFilterCount = 300 = 960,450 − 960,150, 10/10 동일 | 통과 |
| 실패 run 분류 | 대상 0건 |

**discrepancies: 없음.**

records 4건 내역 (전 run 동일):
- 960300 `dedcaf15…22b245` 수신 vout 0, 8,042,543 sat
- 960300 `bafc9764…3ef9d7` 수신 vout 0, 2,181,041 sat
- 960300 `a711d1ac…39dacdb` 수신 vout 0, 7,732,676 sat
- 960316 `1dfb8f65…53d751` 지출 (`a711d1ac…:0` outpoint 소비) — ownedOutpoints 잔여 2건

## 6. 한계

1. **단일 스캔 구간**: 검증 범위는 960,150→960,450 의 300 블록 1개 구간뿐. 다른 구간·재조직(reorg) 상황은 미실측.
2. **PoW 미검증**: `scan.ts` 주석 명시 — "PoW 목표(bits) 검증·누적 난이도 비교를 하지 않는다 — 연결성만 본다." 헤더 체인 연결성만 확인하는 의도적 단순화. 신뢰 근거는 체크포인트 + 다피어 교차 일치.
3. **쿼럼 크기**: filterHeader 쿼럼은 13피어(도달 가능 40개 중), 스캔 교차검증은 10피어. 전수 아님.
4. 헤더 동기화·ground-truth 추출이 단일 피어(126.94.88.240) 의존 — 단, filterHeader 는 13/13 쿼럼, 스캔 결과는 10피어 상호 대조로 상쇄.

## 7. 산출물 경로

스크립트:
- `D:/TTLCOINWalet/scripts/bip157-live/discover.mjs`
- `D:/TTLCOINWalet/scripts/bip157-live/bootstrap.mjs`
- `D:/TTLCOINWalet/scripts/bip157-live/run.mjs`
- `D:/TTLCOINWalet/scripts/bip157-live/verify-cross.mjs`
- `D:/TTLCOINWalet/scripts/bip157-live/node-transport.mjs` (ByteTransport 구현)
- `D:/TTLCOINWalet/scripts/bip157-live/smoke-transport.mjs`

데이터 (out/ — **임시파일, 커밋·푸시 전 삭제 대상**):
- `D:/TTLCOINWalet/scripts/bip157-live/out/peers.json`
- `D:/TTLCOINWalet/scripts/bip157-live/out/fixture.json`
- `D:/TTLCOINWalet/scripts/bip157-live/out/bootstrap.log`
- `D:/TTLCOINWalet/scripts/bip157-live/out/result-0.json` ~ `result-9.json`

본 보고서: `D:/TTLCOINWalet/scripts/bip157-live/REPORT.md`
