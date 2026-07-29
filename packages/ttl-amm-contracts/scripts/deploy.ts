// ─────────────────────────────────────────────────────────────────────────────
// deploy.ts — E-3 배포: WTTL → TtlAmmFactory → TtlAmmRouter (docs/EXCHANGE.md §9)
//
// 자산이 실제로 움직이는 코드다. 그래서:
//   · 드라이런이 기본이다 — 인자 없이 실행하면 배포자 주소·잔액·예상 가스·
//     배포 순서만 출력하고 끝난다. --send 일 때만 실전 전송한다.
//   · 개인키는 환경변수로만 받는다 (hardhat.config.ts 의 BYEORIN_DEPLOY_KEY /
//     BYEORIN_ANCHOR_KEY 폴백). 이 파일은 키를 읽지도, 로그에 남기지도 않는다.
//   · 배포 tx 성공 ≠ 코드 존재. 각 배포 후 eth_getCode 로 코드가 실제로
//     올라갔는지 별도 확인하고, 생성자 인자가 의도대로 박혔는지 읽어서 대조한다.
//   · 결과는 deployments/<network>.json 에 기록한다 — 주소·tx·블록·배포자·
//     컴파일 설정(재현 빌드 검증용). 파일이 이미 있으면 덮어쓰지 않고 중단한다
//     (--force 로만 재배포). 실수로 두 번 배포해 "어느 쪽이 진짜냐"가 생기는
//     것을 파일 존재 자체로 막는다.
//
// 사용 (플래그는 env 로도 켤 수 있다 — `hardhat run` 이 임의 argv 를 스크립트에
// 넘겨주지 않는 환경 대비):
//   npx hardhat run scripts/deploy.ts --network ttl                    # 드라이런
//   BYEORIN_SEND=1 npx hardhat run scripts/deploy.ts --network ttl     # 실전
//   BYEORIN_SEND=1 BYEORIN_FORCE=1 ... --network ttl                   # 재배포
// ─────────────────────────────────────────────────────────────────────────────

import hre, { ethers } from "hardhat";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/** 이 패키지 루트 (scripts/ 의 한 단계 위). */
export const PKG_ROOT = resolve(__dirname, "..");

export interface DeployedContract {
  address: string;
  txHash: string;
  blockNumber: number;
}

/** deployments/<network>.json 의 형식. seed.ts 와 제3자 재현 검증이 읽는다. */
export interface DeploymentRecord {
  version: 1;
  network: string;
  chainId: number;
  deployer: string;
  /** Factory 의 feeToSetter — 배포 시점에는 배포자다 (포기하려면 setFeeToSetter(0)). */
  feeToSetter: string;
  contracts: {
    wttl: DeployedContract;
    factory: DeployedContract;
    router: DeployedContract;
  };
  /** 재현 빌드 검증용 — 이 설정으로 컴파일해야 같은 바이트코드가 나온다. */
  compiler: {
    solcVersion: string;
    optimizer: { enabled: boolean; runs: number };
    evmVersion: string;
  };
  deployedAt: string; // ISO 8601 (UTC)
}

export interface RunDeployOptions {
  /** false(기본) = 드라이런: 아무것도 전송하지 않는다. */
  send: boolean;
  /** deployments 파일이 이미 있어도 진행 (재배포 의도의 명시적 표현). */
  force?: boolean;
  /** 기본: <pkg>/deployments/<network>.json. 테스트가 임시 경로를 주입한다. */
  deploymentsFile?: string;
  log?: (line: string) => void;
}

/** hardhat.config 의 컴파일 설정을 기록용으로 읽는다 — 하드코딩 복제본을 두면 어긋난다. */
function compilerSettings(): DeploymentRecord["compiler"] {
  const c = hre.config.solidity.compilers[0];
  const settings = c.settings as {
    optimizer?: { enabled?: boolean; runs?: number };
    evmVersion?: string;
  };
  return {
    solcVersion: c.version,
    optimizer: {
      enabled: settings.optimizer?.enabled ?? false,
      runs: settings.optimizer?.runs ?? 200,
    },
    evmVersion: settings.evmVersion ?? "default",
  };
}

/** 키 없이 ttl 네트워크에 붙으면 signer 가 0명이다 — 여기서 명확히 안내하고 끝낸다. */
async function requireDeployer(log: (s: string) => void): Promise<HardhatEthersSigner> {
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    log("");
    log("[deploy] 배포 키가 없습니다.");
    log("  개인키는 환경변수로만 받습니다 (argv·파일 금지):");
    log("    BYEORIN_DEPLOY_KEY=0x...   (없으면 BYEORIN_ANCHOR_KEY 폴백)");
    log("  예) PowerShell:");
    log("    $env:BYEORIN_DEPLOY_KEY='0x...'; npx hardhat run scripts/deploy.ts --network ttl");
    log("");
    throw new Error("NO_DEPLOY_KEY");
  }
  return signers[0];
}

/**
 * 배포 tx 성공만으로는 "코드가 그 주소에 있다"를 확인한 것이 아니다 —
 * eth_getCode 로 직접 확인한다. (RPC 프록시가 tx 를 삼키는 류의 사고 대비.)
 */
async function assertCodeExists(name: string, address: string): Promise<void> {
  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code === "0x0") {
    throw new Error(`${name} 배포 tx 는 성공했지만 ${address} 에 코드가 없다 — 중단`);
  }
}

/**
 * 배포 실행. 드라이런이면 null, 실전이면 기록을 반환한다.
 * 순서는 의존성 그대로: WTTL → Factory(feeToSetter=배포자, WTTL) → Router(Factory, WTTL).
 */
export async function runDeploy(opts: RunDeployOptions): Promise<DeploymentRecord | null> {
  const log = opts.log ?? console.log;
  const netName = hre.network.name;
  const file = opts.deploymentsFile ?? join(PKG_ROOT, "deployments", `${netName}.json`);

  log("");
  log(`[deploy] 벼린 거래소 E-3 — 네트워크 ${netName}${opts.send ? " (실전)" : " (드라이런)"}`);

  // 이미 배포 기록이 있으면 중단 — 덮어쓰면 "진짜 주소가 어느 쪽이냐"는
  // 대답 불가능한 질문이 생긴다. 재배포는 --force 로만, 의도를 명시하고 한다.
  if (existsSync(file) && !opts.force) {
    log("");
    log(`[deploy] ⚠ 배포 기록이 이미 있다: ${file}`);
    log("  덮어쓰지 않는다. 정말 재배포하려면 --force (또는 BYEORIN_FORCE=1).");
    log("  기존 배포를 계속 쓰려면 이 파일을 그대로 두고 seed.ts 로 진행하라.");
    log("");
    throw new Error("DEPLOYMENT_EXISTS");
  }

  const deployer = await requireDeployer(log);
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const balance = await ethers.provider.getBalance(deployer.address);
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;

  log(`  chainId   ${chainId}`);
  log(`  배포자    ${deployer.address}`);
  log(`  잔액      ${ethers.formatEther(balance)} TTL`);
  log(`  가스가격  ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  // ttl 네트워크에 붙었는데 chainId 가 7777 이 아니면 RPC 가 다른 체인을 보고
  // 있다는 뜻이다. 여기서 보내면 자산이 엉뚱한 체인에서 움직인다 — 즉시 중단.
  const cfg = hre.config.networks[netName];
  if ("chainId" in cfg && cfg.chainId !== undefined && cfg.chainId !== chainId) {
    throw new Error(`RPC 의 chainId(${chainId})가 config(${cfg.chainId})와 다르다 — 중단`);
  }

  const WTTLFactory = await ethers.getContractFactory("WTTL", deployer);
  const FactoryFactory = await ethers.getContractFactory("TtlAmmFactory", deployer);
  const RouterFactory = await ethers.getContractFactory("TtlAmmRouter", deployer);

  if (!opts.send) {
    // ── 드라이런: 전송 없이 순서·주소·가스만 보여준다 ──────────────────────
    // CREATE 주소는 (배포자, nonce) 로 결정되므로 보내기 전에 예측할 수 있다.
    // 생성자들은 인자를 저장만 하므로(외부 호출 없음) 예측 주소로 가스 추정이 된다.
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const predWttl = ethers.getCreateAddress({ from: deployer.address, nonce });
    const predFactory = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
    const predRouter = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });

    const txW = await WTTLFactory.getDeployTransaction();
    const txF = await FactoryFactory.getDeployTransaction(deployer.address, predWttl);
    const txR = await RouterFactory.getDeployTransaction(predFactory, predWttl);
    const gasW = await deployer.estimateGas(txW);
    const gasF = await deployer.estimateGas(txF);
    const gasR = await deployer.estimateGas(txR);
    const totalGas = gasW + gasF + gasR;
    const cost = totalGas * gasPrice;

    log("");
    log("  배포 순서 (nonce 순 — CREATE 주소 예측):");
    log(`    1. WTTL                                      → ${predWttl}  (~${gasW} gas)`);
    log(`    2. TtlAmmFactory(feeToSetter=배포자, WTTL)   → ${predFactory}  (~${gasF} gas)`);
    log(`    3. TtlAmmRouter(Factory, WTTL)               → ${predRouter}  (~${gasR} gas)`);
    log(`  예상 가스 합계  ${totalGas} gas ≈ ${ethers.formatEther(cost)} TTL`);
    if (balance < cost) {
      log(`  ⚠ 잔액이 예상 비용보다 적다 — 실전 전에 채워야 한다.`);
    }
    log("");
    log("  (드라이런 — 실제 배포하려면 --send 또는 BYEORIN_SEND=1)");
    log("");
    return null;
  }

  // ── 실전: 순서대로 배포하고, 매번 코드 존재와 생성자 인자를 확인한다 ──────
  log("");
  log("  1/3 WTTL 배포…");
  const wttl = await WTTLFactory.deploy();
  await wttl.waitForDeployment();
  const wttlAddr = await wttl.getAddress();
  await assertCodeExists("WTTL", wttlAddr);
  const wttlTx = wttl.deploymentTransaction();
  if (!wttlTx) throw new Error("WTTL 배포 tx 를 찾을 수 없다");
  const wttlRcpt = await wttlTx.wait();
  if (!wttlRcpt) throw new Error("WTTL 배포 receipt 없음");
  log(`      ${wttlAddr}  (tx ${wttlTx.hash}, block ${wttlRcpt.blockNumber})`);

  log("  2/3 TtlAmmFactory 배포…");
  const factory = await FactoryFactory.deploy(deployer.address, wttlAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  await assertCodeExists("TtlAmmFactory", factoryAddr);
  const factoryTx = factory.deploymentTransaction();
  if (!factoryTx) throw new Error("TtlAmmFactory 배포 tx 를 찾을 수 없다");
  const factoryRcpt = await factoryTx.wait();
  if (!factoryRcpt) throw new Error("TtlAmmFactory 배포 receipt 없음");
  log(`      ${factoryAddr}  (tx ${factoryTx.hash}, block ${factoryRcpt.blockNumber})`);

  log("  3/3 TtlAmmRouter 배포…");
  const router = await RouterFactory.deploy(factoryAddr, wttlAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  await assertCodeExists("TtlAmmRouter", routerAddr);
  const routerTx = router.deploymentTransaction();
  if (!routerTx) throw new Error("TtlAmmRouter 배포 tx 를 찾을 수 없다");
  const routerRcpt = await routerTx.wait();
  if (!routerRcpt) throw new Error("TtlAmmRouter 배포 receipt 없음");
  log(`      ${routerAddr}  (tx ${routerTx.hash}, block ${routerRcpt.blockNumber})`);

  // 생성자 인자 읽어서 대조 — "보냈다"가 아니라 "박혔다"를 확인한다.
  const factoryWttl: string = await (factory as unknown as { WTTL(): Promise<string> }).WTTL();
  const factorySetter: string = await (factory as unknown as { feeToSetter(): Promise<string> }).feeToSetter();
  const routerFactory: string = await (router as unknown as { factory(): Promise<string> }).factory();
  const routerWttl: string = await (router as unknown as { WTTL(): Promise<string> }).WTTL();
  if (factoryWttl !== wttlAddr) throw new Error(`Factory.WTTL 불일치: ${factoryWttl} ≠ ${wttlAddr}`);
  if (factorySetter !== deployer.address) throw new Error(`Factory.feeToSetter 불일치: ${factorySetter} ≠ ${deployer.address}`);
  if (routerFactory !== factoryAddr) throw new Error(`Router.factory 불일치: ${routerFactory} ≠ ${factoryAddr}`);
  if (routerWttl !== wttlAddr) throw new Error(`Router.WTTL 불일치: ${routerWttl} ≠ ${wttlAddr}`);
  log("      생성자 인자 읽기 대조 OK (Factory.WTTL / feeToSetter / Router.factory / Router.WTTL)");

  const record: DeploymentRecord = {
    version: 1,
    network: netName,
    chainId,
    deployer: deployer.address,
    feeToSetter: deployer.address,
    contracts: {
      wttl: { address: wttlAddr, txHash: wttlTx.hash, blockNumber: wttlRcpt.blockNumber },
      factory: { address: factoryAddr, txHash: factoryTx.hash, blockNumber: factoryRcpt.blockNumber },
      router: { address: routerAddr, txHash: routerTx.hash, blockNumber: routerRcpt.blockNumber },
    },
    compiler: compilerSettings(),
    deployedAt: new Date().toISOString(),
  };

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  log("");
  log(`[deploy] 기록 완료: ${file}`);
  log("");
  return record;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const send = argv.includes("--send") || process.env.BYEORIN_SEND === "1";
  const force = argv.includes("--force") || process.env.BYEORIN_FORCE === "1";
  try {
    await runDeploy({ send, force });
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 안내를 이미 출력한 정상적 중단들 — 스택 덤프 없이 조용히 실패 코드만.
    if (msg !== "NO_DEPLOY_KEY" && msg !== "DEPLOYMENT_EXISTS") {
      console.error(`[deploy] 실패: ${msg}`);
    }
    return 1;
  }
}

// hardhat run 이 이 파일을 직접 실행할 때만 main 을 돌린다.
// 테스트는 runDeploy 를 import 해서 쓴다.
if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
