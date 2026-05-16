// Live EVM round-trip against a local Clique-style devnet (ganache, chainId 7777).
// Builds a Wallet from the well-known test mnemonic, derives accounts via the SDK,
// transfers 1 ETH from #0 -> #1 using SDK's Wallet.transfer / EvmAdapter, then
// waits for the receipt and verifies success.
//
// Usage: node scripts/devnet-round-trip.mjs

import { Wallet, EvmAdapter } from '../packages/wallet-sdk/dist/index.js';
import { createPublicClient, http, formatEther, parseEther } from '../packages/wallet-sdk/node_modules/viem/_esm/index.js';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const CHAIN_ID = 7777;
const MNEMONIC = 'test test test test test test test test test test test junk';

const ttlDevChain = {
  id: CHAIN_ID,
  name: 'TTL Devnet',
  nativeCurrency: { name: 'TTL', symbol: 'TTL', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const log = (...args) => console.log('[devnet]', ...args);

async function main() {
  log('RPC:', RPC_URL, 'chainId:', CHAIN_ID);

  const publicClient = createPublicClient({ chain: ttlDevChain, transport: http(RPC_URL) });
  const cid = await publicClient.getChainId();
  log('chainId(verified):', cid);
  if (cid !== CHAIN_ID) throw new Error(`chainId mismatch: got ${cid}`);

  const adapter = new EvmAdapter({ chain: ttlDevChain, rpcUrl: RPC_URL });

  const wallet = Wallet.fromMnemonic({ mnemonic: MNEMONIC });
  const acc0 = wallet.account(adapter, 0, 0);
  const acc1 = wallet.account(adapter, 0, 1);
  log('acc0 derivationPath:', acc0.derivationPath, '->', acc0.address);
  log('acc1 derivationPath:', acc1.derivationPath, '->', acc1.address);

  const EXPECTED_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  if (acc0.address.toLowerCase() !== EXPECTED_0.toLowerCase()) {
    throw new Error(`acc0 mismatch: expected ${EXPECTED_0}, got ${acc0.address}`);
  }
  log('acc0 address matches well-known test mnemonic #0 ✓');

  const bal0Before = await adapter.getBalance(acc0.address);
  const bal1Before = await adapter.getBalance(acc1.address);
  log('balance #0 (before):', formatEther(bal0Before), 'TTL');
  log('balance #1 (before):', formatEther(bal1Before), 'TTL');

  const amount = parseEther('1');
  log('intent: transfer 1 TTL from #0 -> #1');

  const t0 = Date.now();
  const txHash = await wallet.transfer(acc0, { to: acc1.address, amount });
  const tBroadcast = Date.now();
  log('broadcast txHash:', txHash, `(took ${tBroadcast - t0}ms)`);

  // Poll for receipt
  let receipt;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      if (receipt) break;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const tMined = Date.now();
  if (!receipt) throw new Error('tx not mined within 30s');

  log('receipt status:', receipt.status);
  log('receipt block #:', receipt.blockNumber.toString());
  log('receipt gas used:', receipt.gasUsed.toString());
  log('receipt cumulative gas:', receipt.cumulativeGasUsed.toString());
  log('receipt effective gas price:', receipt.effectiveGasPrice?.toString());
  log('mine latency:', `${tMined - tBroadcast}ms (total ${tMined - t0}ms)`);

  if (receipt.status !== 'success') throw new Error(`tx reverted: status=${receipt.status}`);

  const bal0After = await adapter.getBalance(acc0.address);
  const bal1After = await adapter.getBalance(acc1.address);
  log('balance #0 (after):', formatEther(bal0After), 'TTL');
  log('balance #1 (after):', formatEther(bal1After), 'TTL');

  const delta1 = bal1After - bal1Before;
  if (delta1 !== amount) {
    throw new Error(`recipient delta mismatch: expected ${amount}, got ${delta1}`);
  }
  log('recipient delta verified: +1 TTL ✓');

  // EIP-1559 vs legacy detection
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  log('latest block baseFeePerGas:', block.baseFeePerGas?.toString() ?? '(none)');
  log('tx type used: EIP-1559 path active =', block.baseFeePerGas != null);

  console.log('\n✅ Live round-trip: built tx → signed → broadcast → confirmed in block', receipt.blockNumber.toString());
}

main().catch((err) => {
  console.error('[devnet] FAIL:', err?.stack ?? err);
  process.exit(1);
});
