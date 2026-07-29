import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";

// TTL 체인은 geth 1.13.15 포크 — Shanghai(PUSH0) 활성 여부가 제네시스에 달려
// 있으므로, 배포 바이트코드가 어느 쪽에서도 도는 "paris" 로 고정한다.
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 999999 },
      evmVersion: "paris",
    },
  },
  paths: {
    sources: "contracts",
    tests: "test",
  },
  networks: {
    hardhat: {
      // 테스트가 창세 규모(수십만 TTL) 시딩을 하므로 기본 1만보다 크게
      accounts: { accountsBalance: "1000000000" + "0".repeat(18) }, // 10억 TTL
    },
  },
};

export default config;
