# TTL Mainnet Deep Probe

Probe date: 2026-05-17
Probe target: `https://rpc.ttl1.top`, `https://ws.ttl1.top`, `https://api.ttl1.top`, `https://scan.ttl1.top`

## Node fingerprint

| Property | Value |
|---|---|
| `web3_clientVersion` | `ttlcoin/v1.13.15-stable-c5ba367e/linux-amd64/go1.22.12` |
| Fork basis | go-ethereum v1.13.15 (rebranded `ttlcoin`) |
| `eth_chainId` | `0x1e61` (7777) |
| `net_version` | `7777` |
| `net_peerCount` | `0x3` (RPC node + 3 sealers = 4 nodes total) |
| `net_listening` | `true` |
| `eth_syncing` | `false` (fully synced) |
| `rpc_modules` | `admin`, `clique`, `eth`, `net`, `rpc`, `txpool`, `web3` |
| `debug_*` | disabled (`-32601 method not available`) |
| `admin_*` | **EXPOSED on public RPC** (see security note) |

## Chain config (from `admin_nodeInfo.protocols.eth.config`)

| Hardfork | Activation block |
|---|---|
| homestead | 0 |
| eip150 | 0 |
| eip155 | 0 |
| eip158 | 0 |
| byzantium | 0 |
| constantinople | 0 |
| petersburg | 0 |
| istanbul | 0 |
| berlin | 0 |
| **london (EIP-1559)** | **0** |
| **Shanghai / Cancun** | **NOT configured** |
| Merge / PoS | NOT applicable (pure Clique PoA) |
| Clique period | 5 seconds |
| Clique epoch | 30000 blocks |
| Genesis hash | `0xd62d617750724b7c84183396e956bf35e8716b654ea86e2b2d2cfe082bdba872` |

The chain is **pre-Shanghai** — latest block has no `withdrawalsRoot`, no `blobGasUsed`, no `excessBlobGas`. EIP-4895 withdrawals and EIP-4844 blobs are unsupported.

## RPC method matrix

| Method | Status | Response |
|---|---|---|
| `eth_chainId` | OK | `0x1e61` |
| `eth_blockNumber` | OK | `0x7efe5` (520165+) |
| `eth_syncing` | OK | `false` |
| `eth_gasPrice` | OK | `0x3b9aca07` (≈1.000000007 gwei) |
| `eth_maxPriorityFeePerGas` | OK | `0x3b9aca00` (1 gwei flat) |
| `eth_feeHistory(4,latest,[])` | OK | `baseFeePerGas: [0x7,…]` (7 wei!), `gasUsedRatio: [0,0,0,0]` |
| `eth_getBlockByNumber('latest',false)` | OK | empty txs, baseFeePerGas `0x7` |
| `eth_getProof` | OK | full Merkle proofs returned |
| `eth_getCode 0x01–0x09` | OK | `0x` (standard precompiles; geth returns empty by design) |
| `eth_getCode 0x100–0x110` | OK | `0x` (no custom precompiles at canonical ranges) |
| `txpool_status` | OK | pending 0, queued 0 |
| `clique_getSigners` | OK | 4 signers (below) |
| `clique_status` | OK | sealerActivity over 64 blocks |
| `clique_getSnapshot('latest')` | OK | full signer + recents table |
| `admin_nodeInfo` | **OK (should be private)** | enode + chain config |
| `debug_traceBlockByNumber` | DISABLED | `-32601` |

### Clique signer set (4)

```
0x0b551d8b57b8a7b7072eb40d1d6defb148e60434   ~1.01366e27 wei  (~1.01 B TTL)
0x49b60177cc7dcd4ec4477a7f9fc42f18fe40cec4   ~9.94818e26 wei  (~0.99 B TTL)
0x9f38dbc8749fb820d5956f0e42c66c60d145aeea   ~1.02568e27 wei  (~1.03 B TTL)
0xbf073bfbeba9a5de28475c532d8174850edd6a68   ~1.01099e27 wei  (~1.01 B TTL)
```

Each signer holds ~1 billion TTL — total premine ≈ 4 billion TTL.

`clique_status` snapshot (64-block window): `inturnPercent` 26.5%, sealerActivity {0b55: 21, 49b6: 21, 9f38: 0, bf07: 22}. Signer `0x9f38…` produced **0 of the last 64 blocks** — likely offline. Yet the chain still progresses normally (3/4 active = quorum > 50%).

### Block production (5s target)

| Block | Timestamp | Δ |
|---|---|---|
| 1 | 1775458762 (2026-04-04 06:19:22 UTC) | — |
| 2 | 1775458767 | 5 s |
| 520211 | 1778946163 | — |
| 520216 | 1778946188 | 5.0 s/block |
| 520220 | 1778946208 | 5.0 s/block |
| 520221 | 1778946213 | 5 s |

Block-time target of **5 s is consistently met**. Block 1 was sealed on 2026-04-04 (≈40 days before this probe).

Block 1 `extraData` reveals seal signature; genesis `extraData` carries the initial signer `0x49b60177cc7dcd4ec4477a7f9fc42f18fe40cec4`. Latest gasUsed = 0 — **chain is effectively idle** (0 user txs in our 64-block window).

### Rate-limit

100 sequential POST `eth_chainId` → 100 × HTTP 200, 0 × 429.
100 parallel POST → 100 × HTTP 200 in 1.42 s, 0 × 429.
**No rate-limiting observed at 100 req / 1.4 s burst.**

## Wallet API (`https://api.ttl1.top`)

Stack: `nginx/1.18.0 (Ubuntu)` → `Express` (`X-Powered-By: Express`, `Content-Length: 139` 404 page).
CORS: `Access-Control-Allow-Origin: *`, methods `GET, POST, OPTIONS`.

### Live endpoints

| Endpoint | Response (truncated) |
|---|---|
| `GET /api/v1/health` | `{"status":"ok","blockNumber":520171}` |
| `GET /api/v1/chain` | `{"chainId":7777,"blockNumber":520179,"gasPrice":"1000000007","totalIndexedBlocks":520178,"totalTransactions":18}` |
| `GET /api/v1/blocks` | `{"blocks":[{"number":...,"hash":...,"timestamp":...,"miner":...,"gas_used":...}]}` (paged list) |
| `GET /api/v1/balance/:address` | `{"address":"0x…","balance":"<wei string>"}` |

### Dead endpoints (HTTP 404)

`/`, `/health`, `/api/health`, `/swagger`, `/swagger.json`, `/openapi.json`, `/docs`, `/api-docs`, `/wallets`, `/api/wallets`, `/info`, `/version`, `/status`, `/ping`, `/api/balance`, `/api/info`, `/api/v1`, `/api/v1/version`, `/api/v1/info`, `/api/v1/status`, `/api/v1/wallets`, `/api/v1/tx`, `/api/v1/transactions`, `/api/v1/transaction`, `/api/v1/block`, `/api/v1/blocks/latest`, `/api/v1/signers`, `/api/v1/account/:addr`, `/api/v1/price`, `/api/v1/prices`, `/api/v1/coingecko`, `/api/v1/explorer`, `/api/v1/stats`, `/api/v1/supply`, `/api/v1/peers`, `/api/v1/network`, `/api/v1/docs`, `/api/v1/swagger`.

**Total transactions across the whole chain = 18** (per `/api/v1/chain`). The chain is essentially empty user-activity-wise.

## Explorer API (`https://scan.ttl1.top`)

Static frontend served by `Express` behind nginx. `GET /` → 200 HTML.
**No backend API** mounted: every Etherscan/Blockscout-shape probe (`/api?module=…`, `/api/v2/blocks/1`, `/api/v2/stats`) returns 404 `Cannot GET /api`. The explorer SPA presumably talks to `api.ttl1.top` or directly to the RPC.

## Findings & inferences

1. TTL is a **standard go-ethereum 1.13.15 fork** rebranded `ttlcoin/v1.13.15-stable-c5ba367e`. Commit hash `c5ba367e` does not match upstream geth 1.13.15 (`8f7eb9cc`), so there are local patches — but the protocol surface area is identical to vanilla geth Clique.
2. **No custom precompiles** in the standard (0x01–0x09) or extended (0x100–0x110) ranges.
3. EIP-1559 **active from block 0**, but baseFee floors at `0x7` wei because there is no demand (`gasUsedRatio` is 0).
4. **No Shanghai/Cancun upgrades** — withdrawals (EIP-4895) and blobs (EIP-4844) are not supported; type-3 txs will be rejected.
5. **Pure Clique PoA**, 4 signers, ~5 s blocks. Quorum is 3/4 right now — signer `0x9f38…` is silent across our 64-block window.
6. Wallet API is a thin **read-only Express service** with 4 working endpoints; no broadcast / signing / wallet-management endpoints. There is **no swagger / openapi**.
7. **`admin_nodeInfo` is exposed on the public HTTP RPC** — leaks enode, listener IP (`207.90.195.148:30303`), chain config. This is a deployment misconfiguration; recommended fix is to drop `admin` from `--http.api`.
8. Genesis premine ≈ 4 B TTL split evenly across the 4 signers; total chain txs = 18 over ~520k blocks (≈30 days of operation).
