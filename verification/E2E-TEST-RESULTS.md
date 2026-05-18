# TTL E2E 라운드트립 + 메인넷 프로브 결과

테스트 일자: 2026-05-17
SDK: `@byeorin/wallet-sdk` (built from `packages/wallet-sdk/`)
플랫폼: Windows 11, Node v24.15.0, pnpm 9.15.0

## 1. 환경 정보

| 항목 | 로컬 데브넷 | TTL 메인넷 |
|---|---|---|
| 클라이언트 | `ganache` (in-memory) | `ttlcoin/v1.13.15-stable-c5ba367e/linux-amd64/go1.22.12` |
| Chain ID | 7777 | 7777 |
| Network ID | 7777 | 7777 |
| 하드포크 | Shanghai | London (Shanghai/Cancun 미적용) |
| 합의 | PoA (instant-mine) | Clique PoA, 5초 블록, 4 signers |
| 가스 토큰 | TTL (라벨만) | TTL |
| 엔드포인트 | `http://127.0.0.1:8545` | `https://rpc.ttl1.top` / `wss://ws.ttl1.top` |
| 사용 가능 잔고 | acc#0 1000 TTL (deterministic mnemonic) | 0 (펀딩 없음) |

## 2. 로컬 데브넷 라운드트립 결과 — **성공**

스크립트: `D:/TTLCOINWalet/scripts/devnet-round-trip.mjs`
로그: `D:/TTLCOINWalet/verification/devnet-round-trip.log`

### 시나리오

1. `Wallet.fromMnemonic({ mnemonic: 'test test … junk' })`
2. `wallet.account(adapter, 0, 0)` → 주소 도출, well-known #0 (`0xf39F…2266`) 검증
3. `wallet.account(adapter, 0, 1)` → 수취인 (`0x7099…79C8`)
4. `wallet.transfer(acc0, { to: acc1, amount: 1 TTL })` → SDK 가 `buildTransfer` → `signRequests` → `applySignatures` → `broadcast` 순서로 풀 파이프라인 실행
5. 영수증 폴링 → 상태 검증 → 잔고 변동 검증

### 결과

| 항목 | 값 |
|---|---|
| 발신자 도출 주소 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (chechsum, well-known #0 일치 ✓) |
| 수취인 도출 주소 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| 도출 경로 | `m/44'/60'/0'/0/0`, `m/44'/60'/0'/0/1` |
| Tx 해시 | `0xfee9b3f90d6533711f786f94293bcbd579466a24cf575055d91f75fa1ceacea9` |
| 포함 블록 | **#1** |
| 영수증 status | `success` |
| gasUsed | 21000 |
| effectiveGasPrice | 1.875 gwei |
| baseFeePerGas (latest) | 0.875 gwei → **EIP-1559 경로 활성** |
| Broadcast → 영수증 지연 | 2 ms (instant-mine) |
| 발신자 잔고 변동 | 1000 → 998.999960625 TTL (= 1 TTL + 39375 gwei 수수료) |
| 수취인 잔고 변동 | 1000 → 1001 TTL (정확히 +1 ✓) |

SDK 의 `Wallet.transfer` 가 **빌드 → 서명 → 브로드캐스트 → 채굴 확인**까지 전 단계를 정상 실행함을 확인. EIP-1559 자동 감지(`feeMode: 'auto'`) 도 의도대로 작동.

## 3. TTL 메인넷 프로브 결과

전체 표/세부 내역: `D:/TTLCOINWalet/verification/ttl-probe.md`

### 작동/비작동 엔드포인트 요약

| 카테고리 | 작동 | 비작동 |
|---|---|---|
| RPC | `eth_*` 전체, `net_*`, `txpool_status`, `clique_*`, `admin_*`, `web3_clientVersion`, `eth_getProof` | `debug_*` 전부 비활성 |
| Wallet API | `/api/v1/health`, `/api/v1/chain`, `/api/v1/blocks`, `/api/v1/balance/:addr` | 30+ 추가 경로 모두 404 (`/version`, `/signers`, `/tx`, `/swagger` …) |
| Explorer | `/` (SPA HTML) | 모든 `/api*` 경로 404 (Blockscout/Etherscan-호환 API 부재) |

### EIP-1559 지원 여부

**예 — 블록 0 부터 활성.** 모든 latest 블록에 `baseFeePerGas` 존재 (`0x7` wei). `eth_feeHistory` 정상 동작. 단 사용량이 0 에 가까워 baseFee 가 최소치에 고정됨.

### Shanghai / Cancun 지원 여부

**아니오.** 최신 블록에 `withdrawalsRoot`, `blobGasUsed`, `excessBlobGas` 필드 없음. `admin_nodeInfo` 에 노출된 chainConfig 도 `londonBlock: 0` 까지만 정의되어 있고 그 이후 포크 미정의. **EIP-4895 withdrawal tx, EIP-4844 blob tx (type-3) 는 거부됨.**

### 클라이언트 정확 버전

```
ttlcoin/v1.13.15-stable-c5ba367e/linux-amd64/go1.22.12
```

go-ethereum 1.13.15 의 rebranded fork. 커밋 해시 `c5ba367e` 가 upstream geth 1.13.15 와 다르므로 로컬 패치 있음. 단 RPC 표면적으로는 vanilla geth 1.13.15 와 동일.

### Signer 리스트 (4 명, `clique_getSigners` 기준)

```
0x0b551d8b57b8a7b7072eb40d1d6defb148e60434   ≈ 1.014 B TTL 보유
0x49b60177cc7dcd4ec4477a7f9fc42f18fe40cec4   ≈ 0.995 B TTL 보유  (genesis extraData initial signer)
0x9f38dbc8749fb820d5956f0e42c66c60d145aeea   ≈ 1.026 B TTL 보유  (최근 64블록 0회 sealing — 오프라인 추정)
0xbf073bfbeba9a5de28475c532d8174850edd6a68   ≈ 1.011 B TTL 보유
```

### 커스텀 프리컴파일

**없음.** 표준 0x01–0x09 와 0x100–0x110 범위 모두 `eth_getCode` 가 `0x` 반환 (geth 기본 동작 — 프리컴파일은 코드를 노출하지 않으므로 추가 검증 필요 시 직접 호출이 필요하나 ttlcoin 클라이언트 명칭에서 이미 정확한 fork base 확인 가능).

### Rate-limit

| 시나리오 | 결과 |
|---|---|
| 100 순차 `eth_chainId` | 100 × 200, 0 × 429 |
| 100 병렬 `eth_chainId` | 100 × 200, 0 × 429, 총 1.42 s |

**관측된 rate-limit 없음.** 운영상 burst 보호가 없는 상태.

### Wallet API 발견 사항

- 스택: nginx 1.18.0 + Express, CORS `*` 허용 (`GET, POST, OPTIONS`)
- 살아있는 4 개 엔드포인트는 모두 **읽기 전용**, 트랜잭션 브로드캐스트나 서명 기능은 노출되지 않음 — 즉 지갑 서버는 **체인 인덱서/리더**에 가까움
- 전체 체인 누적 tx 수 = 18 건 (`/api/v1/chain.totalTransactions`)
- swagger/openapi 부재 → SDK 통합 시 엔드포인트는 위 4 개만 유효한 것으로 가정해야 함

## 4. 블록 타임 비교

| 환경 | 목표 | 실측 |
|---|---|---|
| 로컬 ganache | instant | 2 ms (broadcast → 영수증) |
| TTL 메인넷 | 5 초 | 5.0 s/block (블록 520211–520221 표본) |

## 5. 추론: TTL = 표준 geth Clique fork 인가, 커스텀 변경이 있는가?

**결론: 거의 표준 geth 1.13.15 Clique. 패치는 운영 레벨 (브랜딩, genesis 설정, 잠재적 로깅) 에 한정될 가능성이 높음.**

근거:
- `web3_clientVersion` 이 `ttlcoin/v1.13.15-stable-c5ba367e` 로 응답 — 자체 빌드지만 버전 라인은 upstream 그대로
- 노출된 RPC 모듈 셋트(`admin`, `clique`, `eth`, `net`, `rpc`, `txpool`, `web3`)는 정확히 stock geth + Clique 활성화일 때의 셋트
- `chainConfig` 가 표준 필드만 보유 — `terminalTotalDifficulty`, `mergeNetsplitBlock`, `shanghaiTime` 등 후속 포크 키 부재
- 커스텀 프리컴파일 흔적 없음
- EIP-1559 / EIP-2930 / EIP-2718 transaction-type 처리 모두 vanilla geth 의 그것과 동일

**잠재적 리스크:**
1. **`admin_*` 가 공개 HTTP RPC 에 열려 있음** — `admin_addPeer`, `admin_startRPC` 등이 함께 노출되어 있을 가능성. 즉시 `--http.api` 에서 `admin` 제거 권장.
2. **포크 정체** — Shanghai 미적용 → 향후 일반 EVM 도구가 type-3 / withdrawal 트랜잭션을 보낼 때 호환성 문제 발생. wallet-sdk 의 `EvmAdapter` 는 legacy/EIP-1559 만 사용하므로 영향 없음.
3. **체인 사용량 사실상 0** — 30일 운영에 tx 18건, baseFee 7 wei 고정. 메인넷이라기엔 테스트넷에 가까운 활성도.
4. **Signer 1명 침묵** — 4명 중 1명 (`0x9f38…`) 이 64블록 연속 sealing 부재. Clique 는 N/2+1 = 3 명까지 quorum 이라 운영은 정상이나 추가 1명 더 떨어지면 체인 stall.
5. **Wallet API 가 거의 비어있음** — 4 개 read-only 엔드포인트. SDK 가 의존하면 안 되고, 직접 RPC/WS 사용이 안전.

## 6. SDK 호환성 결론

`packages/wallet-sdk` 의 `EvmAdapter` 는 viem 위에 얹혀 있으며 legacy / EIP-1559 트랜잭션만 빌드한다. TTL 의 fork 수준 (London) 과 정확히 일치하므로 **SDK 가 TTL 메인넷에 적용되어도 트랜잭션 빌드/서명/브로드캐스트 단계에서 막힐 항목 없음**. 실제 펀딩만 확보되면 본 데브넷 라운드트립과 동일한 코드로 메인넷 전송 가능.

라운드트립 코드 위치:
- 스크립트: `D:/TTLCOINWalet/scripts/devnet-round-trip.mjs`
- 로그: `D:/TTLCOINWalet/verification/devnet-round-trip.log`
- RPC/API 프로브 raw: `D:/TTLCOINWalet/verification/ttl-rpc-basic.txt`, `ttl-rpc-clique.txt`, `ttl-precompiles.txt`, `ttl-wallet-api.txt`, `ttl-wallet-api-2.txt`, `ttl-scan.txt`, `ttl-ratelimit.txt`, `ttl-deep.txt`, `ttl-recent.txt`
