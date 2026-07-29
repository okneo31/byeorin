import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";

// TTL 체인은 geth 1.13.15 포크 — Shanghai(PUSH0) 활성 여부가 제네시스에 달려
// 있으므로, 배포 바이트코드가 어느 쪽에서도 도는 "paris" 로 고정한다.

// 배포 키는 환경변수로만 받는다: BYEORIN_DEPLOY_KEY, 없으면 BYEORIN_ANCHOR_KEY 폴백.
// (anchor-release.mjs 와 같은 관례 — argv·파일·로그에 키를 남기지 않는다.)
// 키가 없어도 config 로드는 죽으면 안 된다 — 테스트가 키 없이 돌아야 하므로
// 빈 배열로 폴백한다. 키 없이 ttl 네트워크를 쓰려 하면 스크립트가 안내 후 종료한다.
const rawDeployKey = process.env.BYEORIN_DEPLOY_KEY ?? process.env.BYEORIN_ANCHOR_KEY;
const deployAccounts: string[] = rawDeployKey
  ? [rawDeployKey.startsWith("0x") ? rawDeployKey : `0x${rawDeployKey}`]
  : [];

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
    // TTL 메인넷 (E-3 배포 대상). 자산이 실제로 움직이는 네트워크다 —
    // 스크립트는 드라이런이 기본이고 --send 로만 실전 전송한다.
    ttl: {
      url: "https://rpc.ttl1.top",
      chainId: 7777,
      accounts: deployAccounts,
    },
  },
};

export default config;
