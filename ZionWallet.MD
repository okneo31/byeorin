# ZION 체인 — 멀티체인 월렛 통합 핸드오프

ZION 블록체인을 멀티체인 월렛에 추가하기 위한 통합 명세서. ZION은 Cosmos SDK v0.50 기반 체인이므로, 표준 Cosmos 월렛 스택(CosmJS, secp256k1, bech32, proto-direct 서명)을 그대로 쓸 수 있다. 이 문서는 ZION 고유의 값과 함정을 정리한다.

> 작성 기준: 2026-05-22, ZION Phase 1. 값은 `D:\Zion` 코드베이스에서 추출했고, 각 항목에 출처 파일을 명시했다.

## 1. 네트워크 기본 정보

| 항목              | 값                             | 출처                                                       |
| ----------------- | ------------------------------ | ---------------------------------------------------------- |
| Chain ID (런타임) | `zion`                         | `web/.env.local` `NEXT_PUBLIC_CHAIN_ID=zion`, genesis.json |
| SDK               | Cosmos SDK `v0.50.10`          | `chain/go.mod`                                             |
| Consensus         | CometBFT `v0.38.12`            | `chain/go.mod`                                             |
| 블록 타임         | 6.66초 (timeout_commit 6660ms) | `chain/cmd/zionnode/cmd/root.go`                           |
| 계정 서명 곡선    | secp256k1 (Cosmos 표준)        | 표준                                                       |
| 검증인 합의 키    | ed25519                        | `chain/x/poms/keeper/signers.go`                           |

> **Chain ID 주의** — 코드에 `DefaultGenesisChainID = "zion-phase1"` 상수(`chain/x/vdf/types/genesis.go`)가 있지만 이건 VDF 모듈의 genesis seed 파생용일 뿐이다. **실제 네트워크 chain-id 는 `zion`** 이며, 서명 시 SignDoc 의 `chain_id` 에는 반드시 `zion` 을 넣어야 한다. (로컬 testnet 도 `zion-local-1` 이 아닌 `zion` 을 쓴다.)

### 공개 엔드포인트

| 용도                                | 공개 URL                   | 로컬 포트 |
| ----------------------------------- | -------------------------- | --------- |
| CometBFT RPC (tx 브로드캐스트/조회) | `https://rpc.zion1.top`    | `:26657`  |
| Cosmos LCD / REST                   | `https://lcd.zion1.top`    | `:1317`   |
| zion-api (게이트웨이)               | `https://api.zion1.top`    | `:8080`   |
| BTC 브릿지                          | `https://bridge.zion1.top` | `:8091`   |

월렛은 **RPC + LCD** 만으로 표준 동작(잔액 조회, 서명, 브로드캐스트)이 가능하다. zion-api 는 인덱서 기반 부가 데이터(거래 내역, 잡, 검증인 등)용 선택 사항이다.

## 2. 주소 & 키 파생

| 항목                    | 값                                              |
| ----------------------- | ----------------------------------------------- |
| 계정 bech32 prefix      | `zion`                                          |
| 검증인 operator prefix  | `zionvaloper`                                   |
| 검증인 consensus prefix | `zionvalcons`                                   |
| pubkey prefix           | `zionpub` / `zionvaloperpub` / `zionvalconspub` |
| BIP-44 coin type        | **118** (표준 Cosmos, 커스텀 아님)              |
| 파생 경로               | `m/44'/118'/0'/0/0`                             |

출처: `chain/app/app.go` (`Bech32MainPrefix = "zion"`), `chain/cmd/zionnode/cmd/root.go` (`SetBech32Prefix...`).

→ 표준 Cosmos 주소 파생 코드(coin type 118, secp256k1, bech32 prefix `zion`)를 그대로 쓰면 된다. ATOM/OSMO 등과 동일한 니모닉에서 같은 키가 나온다.

## 3. 토큰 / Denomination

| 표시 단위    | base denom | exponent | 비고                                                         |
| ------------ | ---------- | -------- | ------------------------------------------------------------ |
| kWR (Turing) | `utrg`     | 6        | 스테이킹/가스 기축 통화. 1 kWR = 1,000,000 utrg              |
| BTC          | `ubtc`     | 8        | BTC 페그인 결과물. 1 BTC = 1e8 ubtc = 1e8 sat (1 sat = 1 ubtc) |
| USDT         | `uusdt`    | 6        | AMM 시드용 테스트 코인                                       |
| ETH          | `ueth`     | 6        | AMM 시드용 테스트 코인 (decimals 6 — 표준 18 아님, 주의)     |
| (mock)       | `umock`    | 6        | AMM 테스트 풀 전용                                           |

출처: `chain/x/bankext/types/keys.go` (`Denom = "utrg"`, `PegInDenom = "ubtc"`), `web/lib/keplr.ts` (currencies).

> **온체인 DenomMetadata 미등록** — Phase 1 에서는 `/cosmos/bank/v1beta1/denoms_metadata` 가 비어 있다. 월렛은 표시 단위/exponent 를 위 표대로 하드코딩해야 한다.

## 4. Keplr ChainInfo (chain registry 항목)

월렛이 Keplr 호환 chain registry 를 쓴다면 아래 객체를 그대로 사용하면 된다. 현재 웹앱(`web/lib/keplr.ts`)이 `experimentalSuggestChain` 에 넘기는 검증된 설정이다.

```jsonc
{
  "chainId": "zion",
  "chainName": "Zion",
  "rpc": "https://rpc.zion1.top",
  "rest": "https://lcd.zion1.top",
  "bip44": { "coinType": 118 },
  "bech32Config": {
    "bech32PrefixAccAddr": "zion",
    "bech32PrefixAccPub": "zionpub",
    "bech32PrefixValAddr": "zionvaloper",
    "bech32PrefixValPub": "zionvaloperpub",
    "bech32PrefixConsAddr": "zionvalcons",
    "bech32PrefixConsPub": "zionvalconspub"
  },
  "currencies": [
    { "coinDenom": "kWR",  "coinMinimalDenom": "utrg",  "coinDecimals": 6 },
    { "coinDenom": "BTC",  "coinMinimalDenom": "ubtc",  "coinDecimals": 8, "coinGeckoId": "bitcoin" },
    { "coinDenom": "USDT", "coinMinimalDenom": "uusdt", "coinDecimals": 6, "coinGeckoId": "tether" },
    { "coinDenom": "ETH",  "coinMinimalDenom": "ueth",  "coinDecimals": 6, "coinGeckoId": "ethereum" }
  ],
  "feeCurrencies": [
    { "coinDenom": "kWR", "coinMinimalDenom": "utrg", "coinDecimals": 6,
      "gasPriceStep": { "low": 0.01, "average": 0.025, "high": 0.04 } }
  ],
  "stakeCurrency": { "coinDenom": "kWR", "coinMinimalDenom": "utrg", "coinDecimals": 6 },
  "features": []
}
```

## 5. 가스 / 수수료 — ⚠️ 중요

**Phase 1 에는 수수료 AnteHandler 가 와이어업되어 있지 않다.** `chain/app/app.go` 에 `SetAnteHandler(...)` 호출이 없다 — 수수료 차감도, 시퀀스 검증도 일어나지 않는다. (`MinGasPrices = "0.0001utrg"` 설정은 있지만 실제로 적용되지 않는 placeholder.)

월렛 입장에서의 의미:

- Cosmos tx 구조상 `AuthInfo.Fee` (amount + gas_limit) 필드는 **여전히 채워야** tx 가 디코딩된다.
- `Fee.amount` 는 **빈 배열 또는 `0utrg`** 로 두어도 통과한다. 실제 잔액에서 차감되지 않는다.
- `gas_limit` 은 고정값(예: `200000`)을 넣으면 된다. gas 초과로 실패하지 않는다.
- `'auto'` gas 시뮬레이션에 의존하지 말 것 — zion-api 의 `/v1/tx/simulate` 는 현재 `501` 을 반환할 수 있다. RPC 직접 simulate 는 되지만, 어차피 fee 가 0 이므로 **고정 gas_limit 권장**.

> Phase 2 에서 AnteHandler 가 붙으면 fee/sequence 가 강제된다. 그때 월렛은 `feeCurrencies.gasPriceStep` 기준으로 fee 를 계산하고 account sequence 를 정확히 추적해야 한다. 지금은 sequence 불일치도 거부되지 않지만, **미래 호환을 위해 처음부터 account number / sequence 를 정상 조회·증가시키는 코드로 짜둘 것**을 권장한다.

## 6. 잔액 조회

ZION 에는 커스텀 `bankext` 모듈이 있고, 이 모듈의 `Available` 잔액은 표준 `x/bank` 와 자동 미러된다(아래 §7 참조). 따라서 **단순 잔액은 표준 경로로 읽으면 된다.**

### 6-1. 표준 잔액 (권장, 단순 케이스)

```
GET https://lcd.zion1.top/cosmos/bank/v1beta1/balances/{address}
```

표준 Cosmos `Coin[]` 반환. CosmJS `StargateClient.getAllBalances(address)` 그대로 동작.

### 6-2. 확장 잔액 (escrow/staked/vesting 분해가 필요할 때)

ZION 계정은 5개 버킷으로 잔액이 나뉜다: `available`, `locked_in_escrow`, `pending_debt`, `staked`, `vesting`. 잡 에스크로나 검증인 스테이크를 표시하려면:

```
GET https://api.zion1.top/v1/wallet/{address}
→ { address, available, locked_in_escrow, staked, vesting, pending_debt, total, account, pop_subject_id }
```

또는 온체인 직접: `bankext` 모듈의 `QueryExtendedBalance` gRPC/ABCI 쿼리 (`chain/x/bankext/types/query.pb.go`).

> 월렛의 메인 잔액 표시는 `available` 만 쓰면 된다. `staked`/`escrow` 는 별도 라인으로 보여주는 것이 정확하다.

## 7. 표준 전송 (kWR/BTC 송금)

**일반 송금은 표준 `/cosmos.bank.v1beta1.MsgSend` 를 그대로 쓴다.** ZION 은 `bankext` 전용 송금 메시지를 두지 않았다.

체인에 `SendRestriction` 훅이 걸려 있어, 외부에서 들어온 표준 `MsgSend` 가 자동으로 `bankext` 의 `Available` 원장으로 미러된다(`MirrorBankSend`). 즉 월렛은 **다른 Cosmos 체인과 100% 동일하게** `MsgSend` 를 만들어 서명·브로드캐스트하면 된다. 별도 처리 불필요.

```jsonc
// /cosmos.bank.v1beta1.MsgSend
{
  "fromAddress": "zion1...",
  "toAddress":   "zion1...",
  "amount": [ { "denom": "utrg", "amount": "1000000" } ]   // 1 kWR
}
```

## 8. 서명 & 브로드캐스트

### 서명

- 방식: **proto-direct 서명** (`SIGN_MODE_DIRECT`, CosmJS 표준). 웹앱은 `cosmos_signDirect` 를 쓴다.
- SignDoc 필드: `bodyBytes`, `authInfoBytes`, `chainId`(= `"zion"`), `accountNumber`.
- amino(legacy) 서명 코덱도 커스텀 메시지에 등록돼 있으나(아래 §9), **direct 서명을 기본**으로 하라.

### account number / sequence 조회

```
GET https://lcd.zion1.top/cosmos/auth/v1beta1/accounts/{address}
```

(§5 의 이유로 지금은 sequence 가 틀려도 통과하지만, 정상 조회·증가 코드로 작성 권장.)

### 브로드캐스트 — 두 가지 경로

1. **CometBFT RPC 직접** (권장, 표준): CosmJS `SigningStargateClient.connectWithSigner("https://rpc.zion1.top", signer)` → `signAndBroadcast(...)`.

2. **zion-api 경유**:

   ```
   POST https://api.zion1.top/v1/tx/broadcast
   Body: { "tx_bytes": "<base64 proto-marshalled signed Tx>" }
   ```

   CometBFT 응답 envelope(`code`, `hash`, `raw_log`, `events`) 반환.

   성공 판정: 응답 `code === 0`.

## 9. 커스텀 모듈 메시지 타입

표준 송금 외에 ZION 고유 기능(잡 마켓, AMM, BTC 페그, PoP)을 월렛에서 지원하려면 아래 proto 메시지를 등록해야 한다. 각 모듈의 `types/codec.go` 가 `RegisterInterfaces` 로 sdk.Msg 를 등록한다. CosmJS `Registry` 에 type URL + 인코더를 추가하면 된다.

### bankext — `zion.bankext.v1` (`chain/x/bankext/types/tx.pb.go`)

주로 BTC 브릿지/시드용. 일반 송금에는 불필요.

| Type URL                                 | 주요 필드                                                    | 용도                                                         |
| ---------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `/zion.bankext.v1.MsgClaimSeed`          | `claimant`                                                   | 999 kWR 각성 시드 청구 (90 kWR 자동 스테이크 + 30일 전송 제한) |
| `/zion.bankext.v1.MsgPegInBTC`           | `authority, btc_txid, btc_vout, amount_sats, recipient, bip84_path` | BTC 입금 확정 시 ubtc 민팅 (브릿지 권한자 전용)              |
| `/zion.bankext.v1.MsgPegOutBTC`          | `requester, amount_sats, btc_recipient`                      | ubtc → BTC 환원 요청                                         |
| `/zion.bankext.v1.MsgConfirmPegOutBTC`   | `authority, request_id, btc_txid`                            | 페그아웃 확정 (권한자)                                       |
| `/zion.bankext.v1.MsgRefundPegOutBTC`    | `authority, request_id, reason`                              | 페그아웃 환불 (권한자)                                       |
| `/zion.bankext.v1.MsgSetBridgeAuthority` | `signer, new_bridge_authority`                               | 브릿지 권한자 교체 (gov)                                     |

> 일반 유저 월렛은 `MsgClaimSeed` 정도만 노출하면 충분. 나머지는 브릿지 서비스/거버넌스용. **유저는 BTC 페그인을 직접 `MsgPegInBTC` 로 하지 않는다** — §11 의 브릿지 흐름을 쓴다.

### job — `zion.job.v1` (`chain/x/job/types/tx.pb.go`)

| Type URL                           | 주요 필드                                                    |
| ---------------------------------- | ------------------------------------------------------------ |
| `/zion.job.v1.MsgCreateJob`        | `requester, category, tags[], reward(Coin), review_fee(Coin), complexity, deadline_height, ai_allowed, content_hash(bytes), review_fee_bps, duration_blocks` |
| `/zion.job.v1.MsgClaimJob`         | `worker, job_id`                                             |
| `/zion.job.v1.MsgSubmitWork`       | `worker, job_id, work_hash(bytes)`                           |
| `/zion.job.v1.MsgCancelJob`        | `requester, job_id, reason`                                  |
| `/zion.job.v1.MsgRequestExtension` | `worker, job_id, additional_blocks, reason`                  |
| `/zion.job.v1.MsgRespondExtension` | `requester, job_id, accepted`                                |

> `MsgDispute` 는 코덱에 등록돼 있으나 msg-server 핸들러 미구현 — 보내지 말 것. `content_hash` 는 잡 설명 본문의 SHA256(32바이트). 본문은 오프체인 저장: `PUT /v1/jobs/descriptions/{hash}`.

### amm — `zion.amm.v1` (`chain/x/amm/types/tx.pb.go`)

| Type URL                          | 주요 필드                                                    |
| --------------------------------- | ------------------------------------------------------------ |
| `/zion.amm.v1.MsgSwap`            | `swapper, pool_id, amount_in(Coin), min_amount_out(string), denom_out(string)` |
| `/zion.amm.v1.MsgCreatePool`      | `creator, initial0(Coin), initial1(Coin)`                    |
| `/zion.amm.v1.MsgAddLiquidity`    | `provider, pool_id, amount0(Coin), amount1(Coin)`            |
| `/zion.amm.v1.MsgRemoveLiquidity` | `provider, pool_id, shares(string)`                          |

> 스왑 전 `GET /v1/amm/pools/{id}` 로 리저브 확인 후 `min_amount_out` 으로 슬리피지 보호.

### pop — `zion.pop.v1` (Proof-of-Personhood, `chain/x/pop/types/tx.pb.go`)

| Type URL                          | 주요 필드                                                    |
| --------------------------------- | ------------------------------------------------------------ |
| `/zion.pop.v1.MsgProposePathA`    | `proposer_wallet, declared_mode`                             |
| `/zion.pop.v1.MsgVouch`           | `voucher, proposer_wallet`                                   |
| `/zion.pop.v1.MsgSubmitPathB`     | `wallet, source(enum), external_id_hash(bytes), verification_proof(bytes), declared_mode` |
| `/zion.pop.v1.MsgRegisterAIAgent` | `principal_wallet, agent_id, model_name, model_version, purpose` |
| `/zion.pop.v1.MsgRevokePoP`       | `signer, wallet, reason`                                     |

### poms — `zion.poms.v1` (검증인)

SDK 패키지가 아직 이 메시지들을 export 하지 않아, 웹앱은 `web/lib/poms-msgs.ts` 에서 **proto 인코더를 직접 손으로 구현**했다. 월렛이 검증인 등록까지 지원한다면 이 파일을 참고:

| Type URL               | 필드 (proto tag)                                             |
| ---------------------- | ------------------------------------------------------------ |
| `MsgRegisterValidator` | `operator`(1, string), `consensus_pubkey`(2, bytes), `moniker`(3, string) |
| `MsgUnjail`            | `validator`(1, string)                                       |
| `MsgResetTombstone`    | `signer`(1, string), `operator`(2, string)                   |

### burn — `zion.burn.v1`

유저 대면 메시지 **없음**. 무시.

## 10. HTTP API 요약 (zion-api, 선택)

월렛 부가 기능용. 베이스 `https://api.zion1.top`. 모든 응답은 `{error, message, details?}` 형태의 에러 envelope 사용.

| 분류     | 엔드포인트                                                   |
| -------- | ------------------------------------------------------------ |
| 잔액     | `GET /v1/wallet/{address}` (확장), `GET /v1/wallet/{address}/balance` (bank-only) |
| 거래내역 | `GET /v1/wallet/{address}/transactions?limit=&before=`       |
| tx       | `POST /v1/tx/broadcast`, `POST /v1/tx/simulate` (501 가능)   |
| 블록     | `GET /v1/blocks`, `/v1/blocks/{height}`, `/v1/transactions/{hash}` |
| 잡       | `GET /v1/jobs`, `/v1/jobs/{id}`, `PUT|GET /v1/jobs/descriptions/{hash}` |
| AMM      | `GET /v1/amm/pools`, `/v1/amm/pools/{id}`                    |
| 검증인   | `GET /v1/validators`, `/v1/validators/{address}`             |
| 네트워크 | `GET /v1/stats/network`, `/v1/stats/supply`                  |
| 실시간   | `GET /v1/stream` (WebSocket: block/event 구독)               |
| 헬스     | `GET /healthz`, `/readyz`                                    |

Rate limit: 읽기 60 RPS, 쓰기 10 RPS, 검색 20 RPS (per-IP). 전체 명세는 `api/internal/server/openapi.yaml` 이 정본.

## 11. BTC 브릿지 통합 (peg-in)

유저가 BTC 를 ZION 으로 가져오는 흐름. 베이스 `https://bridge.zion1.top`.

```
1. 월렛 → POST /v1/bridge/allocate   { "zion_address": "zion1..." }
        ← { btc_address, path, index, network }
2. 유저가 받은 btc_address 로 BTC 송금
3. 브릿지가 컨펌(mainnet 2 / signet 1) 감지 → 자동으로 MsgPegInBTC → ubtc 민팅
4. 월렛 → GET /v1/bridge/status?zion_address=zion1...
        ← { allocation, mints[], network }
```

- `allocate`: IP당 시간당 10회 제한 (429 + `Retry-After: 3600`).
- `status`: `BTC_BRIDGE_STATUS_SECRET` 설정 시 `X-Zion-Auth` 헤더 필요 — 먼저 `GET /v1/bridge/status/challenge?zion_address=...` 로 토큰을 받는다. 토큰 = `sha256(zion_address:secret:YYYYMMDD)`, 당일·전일 UTC 유효.
- CORS: `BTC_BRIDGE_ALLOWED_ORIGIN` 으로 제어. **웹 기반 월렛이면 자기 origin 을 이 환경변수에 추가해야** 브라우저에서 호출 가능 (네이티브 앱은 무관).
- 최소 페그인 금액: 기본 10000 sat.
- peg-out(ZION→BTC)은 Phase 1 미오픈.

## 12. 통합 시 함정 체크리스트

-  **chain-id 는 `zion`** — 코드 상수 `zion-phase1` 에 속지 말 것. SignDoc 에 `zion` 사용.
-  **수수료 0** — `Fee.amount` 빈 배열/`0utrg`, `gas_limit` 고정값. `'auto'` 시뮬레이션 의존 금지.
-  **DenomMetadata 없음** — exponent(utrg=6, ubtc=8, uusdt=6, ueth=6)를 하드코딩.
-  **ueth decimals 6** — 표준 ETH 의 18 이 아니다.
-  **일반 송금 = 표준 MsgSend** — bankext 전용 송금 메시지 없음. SendRestriction 이 자동 미러.
-  **잔액은 `available` 버킷** — 표준 bank 엔드포인트 = available. escrow/staked 는 확장 쿼리.
-  **coin type 118 / secp256k1 / prefix `zion`** — 표준 Cosmos 키 파생.
-  **sequence** — 지금은 강제 안 되지만 Phase 2 대비해 정상 추적 코드로 작성.
-  **MsgDispute 보내지 말 것** — 핸들러 미구현.

## 13. 핵심 소스 파일 레퍼런스

| 목적                    | 경로                                                  |
| ----------------------- | ----------------------------------------------------- |
| 체인 파라미터/bech32    | `chain/app/app.go`, `chain/cmd/zionnode/cmd/root.go`  |
| denom 상수              | `chain/x/bankext/types/keys.go`                       |
| 커스텀 메시지 (proto)   | `chain/x/{bankext,job,amm,pop}/types/tx.pb.go`        |
| 코덱 등록               | `chain/x/*/types/codec.go`                            |
| Keplr 연동 레퍼런스     | `web/lib/keplr.ts`                                    |
| 지갑 상태/서명          | `web/lib/wallet-store.ts`, `web/lib/walletconnect.ts` |
| poms 메시지 수동 인코더 | `web/lib/poms-msgs.ts`                                |
| API 정본 명세           | `api/internal/server/openapi.yaml`                    |
| 브릿지 HTTP             | `services/btc-bridge/http.go`                         |

*이 문서는 코드 스냅샷(2026-05-22) 기준이다. Phase 2 에서 수수료 AnteHandler 가 와이어업되면 §5 를 갱신할 것.*