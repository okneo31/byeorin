import { defineConfig } from 'tsup';

export default defineConfig({
  // 진입점:
  //   - index : 전체 barrel (역호환 — 모든 체인 어댑터 포함).
  //   - core  : 체인 어댑터 없는 좁은 표면 (Wallet/시그너/시드/HW 트랜스포트/타입).
  //   - evm   : EVM 전용 (TTL 등) — viem 만 의존.
  // popup/background 처럼 EVM 만 쓰는 컨슈머는 core+evm 만 import 해 cosmos/ton/xrp/...
  // 라이브러리가 bundle 에 끌려오지 않도록 한다.
  entry: ['src/index.ts', 'src/core.ts', 'src/evm.ts', 'src/multichain.ts', 'src/btc-history.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'es2022',
});
