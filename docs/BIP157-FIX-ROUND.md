# BIP157 수정 라운드 보고서 (부대 16/16)

작성일: 2026-08-01 · 브랜치 main · 기준 커밋 1c78b20 이후 작업트리

## 1. 결론

**9건(D1–D5, N1–N4) 전부 수정 확정 + 부수 2건(T1·T2) 적용. BIP157 3스위트 118/118 통과 (수정 전 의도적 실패 4건 포함 전건 통과), 패키지 전체 685건 중 675 통과·10 skip·0 실패, tsc --noEmit 무오류, build 성공.**

수정 전 실측 60건 중 56 통과·4 실패 → 수정 후 3스위트 총 118건 118 통과 (스위트 재계수: btc-bip157 58 + errors 47 + reorg 13).

## 2. 결함별 표

| ID | 심각도 | 파일:라인 (수정 후) | 수정 내용 | 검증 방법 | 판정 |
|---|---|---|---|---|---|
| D1 | 심각 | messages.ts:484-501, scan.ts:526-531 | computeMerkleRoot 신설 (txid 트리·홀수 복제·CVE-2012-2459 짝중복 거부) + scan 에서 블록마다 header.merkleRoot 대조 | 실피어 공격 스크립트: tx 제거·추가·CVE 복제 3종 위조 전부 거부, 정상 블록 통과 (h350000, tx 1795개, 피어 2곳 재현) | 맞음 |
| D2 | 심각 | scan.ts:336-349, 368-373 | 무진전 즉시 예외 종료 + 라운드 절대 상한 maxRounds(기대라운드×2+8) | errors (l) [VULN] 통과: rounds ≤ 2 에서 원인 명시 예외로 유한 종료. reorg 13건 스위트 1.4s 완주 | 맞음 |
| D3 | 심각 | scan.ts:129-142, 189-206 | RESPONSE_COMMANDS 화이트리스트 + 큐 상한 2048통/64MiB, 초과 시 예외 종료 | 부하 실측: 폭주 57.5MiB 수신 시 힙 증가 64.6MB → 0.52MiB (124분의 1 = 64.6÷0.52). 상한 발동 = 정확히 2,049통째 | 맞음 |
| D4a | 심각 | scan.ts:511-540 | getdata 배치 수집 후 높이 오름차순 스캔 (도착 순서 의존 제거) | 코드 실증 검토 + errors (m)·대조군 통과 | 맞음 |
| D4b | 심각 | scan.ts:79-82, 539 | knownOutpoints 계약 JSDoc 명문화 + emptyMatchedBlockHeights 신호 필드 | 코드 실증 검토 | 맞음 |
| D5 | 중 | scan.ts:176-188 | ping 파싱 전용 try — 망가진 ping 무시, 연결 유지 | errors [VULN] ping 예외 테스트 통과 전환 | 맞음 |
| N1 | 심각 | scan.ts:437-447 | cfilter 매칭을 현 배치 전용 batchByHash 로 한정, 배치 밖 응답은 예외 | errors 스위트 통과 (기존 오류 문구 유지 확인) | 맞음 |
| N2 | 중 | scan.ts:443 | cf.filterType !== BASIC 검증 추가 | 코드 실증 검토 | 맞음 |
| N3 | 경미 | p2p.ts:163-166 | version nonce 를 CSPRNG 기반 u64 로 (Math.random 32비트 대체) | 코드 실증 검토, opts.nonce 명시 경로 불변 | 맞음 |
| N4 | 경미 | scan.ts:377 | 소배치 응답을 "피어 팁 도달" 조건과 결합해야 종료 | 실피어 헤더 960,508개 완주 (수정 전 960,497개와 동등 완주) | 맞음 |
| T1 | 부수 | scripts/btc-p2p/node-transport.mjs:52 | setNoDelay(true) | 실측 519ms→259ms (10회 중 9회 재현) | 맞음 |
| T2 | 부수 | p2p.ts:107 | P2PFrameDecoder 진입 시 chunk 복사 — 재사용 버퍼 안전 | 복사 비용 계산: 헤더 96만 개 = 480프레임 ≈ 77.8MB, ÷5GB/s ≈ 15.6ms (무시 가능) | 맞음 |

## 3. 테스트

- 수정 전 실측: 60건 중 56 통과 · 4 실패 (의도적 [VULN] 4건).
- 수정 후 실측 (이 보고서 작성 시 직접 재실행): **BIP157 3스위트 118/118 통과** — btc-bip157.test.ts 58, btc-bip157-errors.test.ts 47, btc-bip157-reorg.test.ts 13. 패키지 전체 `pnpm --filter @byeorin/wallet-sdk test` = 685건 중 675 통과 · 10 skip · **0 실패**. `tsc --noEmit` 무오류.
- **테스트 무결성 감사: 약화 없음.** 의도적 실패 4건([VULN] 무진전 / 힙 폭주 / ping 예외 / getheaders 11회)의 본문·기대값은 커밋 1c78b20 원본 그대로 (검증 부대: 3파일 diff 0줄, .skip/xit/xdescribe 0건 확인). 이 라운드에서 추가로 적용한 픽스처 패치(설계 1 패치 5-8)는 헤더 merkleRoot 를 실제 서빙 tx 목록의 computeMerkleRoot 실값으로 채우는 변경뿐 — `git diff -- tests/` 에서 expect/skip 계열 라인 변경 0건을 직접 확인했다. 기대값을 구현에 맞춘 것이 아니라, D1 검증이 들어온 뒤에도 모의 피어가 "정직한 피어" 전제를 지키도록 픽스처를 규격에 맞춘 것이다.
- diff 규모: `git diff --stat` = 7파일, +177/−39 (messages.ts +29, p2p.ts +19, scan.ts 138줄 변경, index.ts +1, errors 테스트 5줄, reorg 테스트 20줄, node-transport.mjs +4).

## 4. 실피어 회귀

- 5피어(126.94.88.240 / 106.51.20.106 / 174.31.125.203 / 211.54.72.211 / 82.67.102.15) 전원 기준값과 전건 일치: tipHeight=960450, scannedFilterCount=300, matchedBlockCount=2, records=4, expectedFound=3 (txid 3건 동일).
- 성능 회귀 폭: 중앙값 (2488 − 3637) ÷ 3637 = **−31.6%** (머클 검증 추가에도 단축 — T1 부합하나 단일 라운드라 원인 단정 안 함). 회귀 없음.
- 실피어 완주 2종 추가: cfheaders 960,508개 · 74.21MB · 58.8s 체인검증 4구간 PASS / e2e-scan S0–S7 전 단계 통과 (getheaders 29회, 거짓음성 0).

## 5. 공격 재현

- 머클 위조 3종: tx 제거 = 거부, tx 추가 = 거부 ("merkle root mismatch — peer lied"), CVE-2012-2459 복제 = 참조 무방어 머클로 루트 충돌 성립 확인 후 "duplicate merkle node" 로 거부. 정상 블록 = 통과. 피어 2곳 재현 동일.
- 메모리 DoS: 화이트리스트 밖 폭주 힙 증가 64.6MB → 0.52MiB (÷124). 화이트리스트 안 폭주는 2,049통째 예외 종료, 상주 14.63MiB < 상한 64MiB. 정상 스캔 무영향 (폭주 사이 진짜 응답 전달 테스트 통과, 실피어 미발동).

## 6. 남은 것

수정 안 한 것 (보고만, 이번 라운드 범위 밖):

1. **scan.ts:166 handleChunk 에 closedErr 가드 없음** — 오버플로로 닫힌 뒤에도 잔여 프레임을 계속 디코드하며 transport.close() 반복 호출 (실측 closeCount 12,952/15,000통). 멱등이라 오답은 없으나 낭비 경로. `if (this.closedErr) return` 1줄감.
2. **blockBatchSize > 16 설정 + 4MB 급 블록 연속 시** 정직한 피어도 64MiB 큐 상한에 걸릴 수 있음 (기본값 16은 최악 60MB로 안전).
3. **expectedRounds 가 라운드당 2000헤더 가정** — 항상 소배치로 응답하는 정직한 피어는 진전 중에도 maxRounds 예외 가능 (Bitcoin Core 는 2000개 응답이라 실전 발현 낮음).
4. **깊이 8 초과 재조직 시 정직한 피어와도 "무진전" 예외 종료** (K=1 설계 편차, 문서화됨) — 회복이 아닌 명시적 실패, 다음 스캔 재시도 몫. errors.test.ts:1004 의 rounds ≤ 2 단언이 widen 재시도를 허용하지 않아 의도된 결과.
5. **locator 는 지수 back-off 가 아님** — 실물 캡처 결과 "끝 8개 연속 + 체크포인트" 9개. 임무 전제의 서술 오류였음 (구현 결함 아님).

미검증 영역: 셸(안드로이드/데스크톱/릴레이) 전송 구현에서의 T2 실발현 여부 — p2p.ts 복사 계약으로 방어했으나 각 셸 실기 테스트는 안 함. testnet 미실행 (mainnet 만).

## 7. 산출물·임시파일

변경 파일 (커밋 대상 후보 — 커밋·푸시 지시 없어 작업트리 상태 유지):

- D:/TTLCOINWalet/packages/wallet-sdk/src/btc-history/bip157/messages.ts
- D:/TTLCOINWalet/packages/wallet-sdk/src/btc-history/bip157/scan.ts
- D:/TTLCOINWalet/packages/wallet-sdk/src/btc-history/bip157/p2p.ts
- D:/TTLCOINWalet/packages/wallet-sdk/src/btc-history/bip157/index.ts (computeMerkleRoot export — 이 라운드에서 반영)
- D:/TTLCOINWalet/packages/wallet-sdk/tests/btc-bip157-errors.test.ts (픽스처 merkleRoot 실값화)
- D:/TTLCOINWalet/packages/wallet-sdk/tests/btc-bip157-reorg.test.ts (픽스처 merkleRoot 실값화)
- D:/TTLCOINWalet/scripts/btc-p2p/node-transport.mjs (setNoDelay)
- D:/TTLCOINWalet/docs/BIP157-FIX-ROUND.md (이 보고서)

임시파일 (삭제 대상 — 커밋 전 정리 필요, 아직 안 지움):

- D:/TTLCOINWalet/scripts/fix-round-out/attack-merkle.mjs
- D:/TTLCOINWalet/scripts/fix-round-out/d3-heap-bench.test.ts
- D:/TTLCOINWalet/scripts/fix-round-out/messages-src.mjs
- D:/TTLCOINWalet/scripts/fix-round-out/regress-0.json ~ regress-4.json (5개)
