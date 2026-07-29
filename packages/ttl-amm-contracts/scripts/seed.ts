// ─────────────────────────────────────────────────────────────────────────────
// seed.ts — E-3 시딩: genesis-seed.json 의 전 풀을 창세 가격 그대로 채운다.
// (풀 개수·수치는 전적으로 그 파일이 정한다 — 여기 하드코딩된 개수는 없다.)
//
// 입력은 두 파일뿐이다: deployments/<network>.json (deploy.ts 산출물) 과
// 저장소 루트 genesis-seed.json. 수치는 재계산하지 않는다 — genesis-seed 가
// 시딩 수치의 유일한 입력이고, 그 파일이 rate-snapshot 에서 기계적으로 유도됐다는
// 사실이 제3자 재현 검증의 근거다 (docs/EXCHANGE.md §5).
//
// 풀마다 2 tx:
//   ① token.approve(Router, tokenWei)                        — 정확한 양만
//   ② Router.addLiquidityNative(token, tokenWei, tokenWei,   — min == desired
//                               ttlWei, 배포자, deadline) + value: ttlWei
//
// min 을 desired 와 같게 두는 이유: 시딩 전에 누군가 그 페어에 다른 비율로
// 유동성을 넣어뒀다면 Router 의 optimal 계산이 우리 수치를 깎아서 넣으려 한다.
// 그걸 허용하면 창세 가격이 왜곡된 채로 "성공"한다 — 1 wei 도 양보하지 않으면
// tx 가 revert 하고 그 풀이 보고된다. 창세 가격의 정확성이 곧 스나이핑 방어다
// (EXCHANGE.md §8: 스냅샷과 일치하면 먹을 불균형이 없다).
//
// 풀 수 × 2tx (60여 풀이면 130tx 안팎) — 중간 실패가 정상 상황이다. 그래서:
//   · 진행 상황을 deployments/seed-progress.json 에 풀 단위로 기록하고,
//     재실행 시 완료된 풀은 건너뛴다 (건너뛴 사실을 출력한다 — 조용한 스킵 금지).
//   · 한 풀이 실패해도 다음 풀로 계속 간다. 실패 목록은 마지막에 모아 보고한다.
//   · 시딩 전 사전 검사(잔액·기존 준비금)를 전 풀에 대해 돌리고, 하나라도
//     실패하면 tx 를 하나도 보내지 않고 목록을 출력하며 중단한다.
//
// 드라이런 기본 / --send 실전. 완료 후 각 풀의 getReserves 를 읽어
// reserveToken/reserveTtl == perTtl 검산 결과를 출력한다 — "시딩이 끝났다"는
// 주장과 "창세 가격이 맞다"는 확인은 다른 것이기 때문이다.
//
// 사용:
//   npx hardhat run scripts/seed.ts --network ttl                    # 드라이런
//   BYEORIN_SEND=1 npx hardhat run scripts/seed.ts --network ttl     # 실전
// ─────────────────────────────────────────────────────────────────────────────

import hre, { ethers } from "hardhat";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Contract } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { PKG_ROOT, type DeploymentRecord } from "./deploy";

/** 저장소 루트 — packages/ttl-amm-contracts/scripts 에서 세 단계 위. */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

// ── 입력 형식 ────────────────────────────────────────────────────────────────

/** genesis-seed.json 의 풀 하나. 스크립트가 쓰는 필드만 적는다 (여분 필드는 무시). */
export interface GenesisPool {
  iso: string;
  symbol: string;
  token: string; // TTL 체인 위 t토큰 주소
  decimals: number;
  perTtl: number; // 표시·검산 참고용 — 금액 계산에는 쓰지 않는다 (float)
  ttlWei: string; // TTL 쪽 시딩량 (wei, 문자열)
  tokenWei: string; // 토큰 쪽 시딩량 (wei, 문자열)
  mintNeeded?: string; // 잔액 부족 안내 참고값 (생성 시점 기준)
}

export interface GenesisSeedFile {
  totals: { pools: number; ttlWeiTotal: string };
  pools: GenesisPool[];
}

// ── 진행 기록 ────────────────────────────────────────────────────────────────

export interface PoolProgress {
  pair: string;
  approveTx: string;
  addTx: string;
  blockNumber: number;
}

export interface SeedProgress {
  version: 1;
  network: string;
  chainId: number;
  /** 이 진행 기록이 어느 배포에 속하는지 — Router 주소가 다르면 다른 세계다. */
  router: string;
  completed: Record<string, PoolProgress>; // key = iso
}

// ── 결과 ─────────────────────────────────────────────────────────────────────

export interface VerifyResult {
  iso: string;
  pair: string;
  reserveTtl: bigint;
  reserveToken: bigint;
  /** 준비금이 genesis-seed 수치와 wei 단위로 정확히 같은가 (가장 강한 검산). */
  exactWei: boolean;
  /** reserveToken/reserveTtl 비율이 tokenWei/ttlWei 와 같은가 (스케일드 bigint 비교). */
  ratioOk: boolean;
}

export interface SeedSummary {
  seeded: string[];
  skippedCompleted: string[];
  failed: { iso: string; reason: string }[];
  verify: VerifyResult[];
}

export interface RunSeedOptions {
  /** false(기본) = 드라이런: 사전 검사 + 첫 3풀 tx 미리보기만. */
  send: boolean;
  /** 파일 대신 직접 주입 (통합 테스트용). */
  deployment?: DeploymentRecord;
  seed?: GenesisSeedFile;
  deploymentsFile?: string;
  seedFile?: string;
  progressFile?: string;
  /** 드라이런에서 미리보기할 풀 수 (기본 3). */
  previewCount?: number;
  log?: (line: string) => void;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
] as const;

const RATIO_SCALE = 10n ** 18n;

/** 스케일드 bigint 비율을 소수 문자열로 (표시 전용 — 금액 계산 아님). */
function formatRatio(numer: bigint, denom: bigint, places = 6): string {
  const scaled = (numer * 10n ** BigInt(places)) / denom;
  const s = scaled.toString().padStart(places + 1, "0");
  return `${s.slice(0, -places)}.${s.slice(-places)}`;
}

/** wei 문자열 검증 겸 변환 — genesis-seed 가 손상됐으면 여기서 바로 잡는다. */
function toWei(value: string, what: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${what} 가 정수 문자열이 아니다: ${value}`);
  return BigInt(value);
}

function loadJson<T>(path: string, what: string): T {
  if (!existsSync(path)) {
    throw new Error(`${what} 이 없다: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function requireSigner(log: (s: string) => void): Promise<HardhatEthersSigner> {
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    log("");
    log("[seed] 배포 키가 없습니다.");
    log("  개인키는 환경변수로만 받습니다: BYEORIN_DEPLOY_KEY (폴백 BYEORIN_ANCHOR_KEY)");
    log("  예) $env:BYEORIN_DEPLOY_KEY='0x...'; npx hardhat run scripts/seed.ts --network ttl");
    log("");
    throw new Error("NO_DEPLOY_KEY");
  }
  return signers[0];
}

// ── 본체 ─────────────────────────────────────────────────────────────────────

export async function runSeed(opts: RunSeedOptions): Promise<SeedSummary | null> {
  const log = opts.log ?? console.log;
  const netName = hre.network.name;

  const deploymentsFile = opts.deploymentsFile ?? join(PKG_ROOT, "deployments", `${netName}.json`);
  const seedFile = opts.seedFile ?? join(REPO_ROOT, "genesis-seed.json");
  const progressFile = opts.progressFile ?? join(PKG_ROOT, "deployments", "seed-progress.json");

  log("");
  log(`[seed] 벼린 거래소 E-3 시딩 — 네트워크 ${netName}${opts.send ? " (실전)" : " (드라이런)"}`);

  // ── 입력 로드 ──────────────────────────────────────────────────────────────
  const deployment =
    opts.deployment ??
    loadJson<DeploymentRecord>(deploymentsFile, "배포 기록 (deploy.ts 를 먼저 실행하라)");
  const genesis = opts.seed ?? loadJson<GenesisSeedFile>(seedFile, "genesis-seed.json");

  // genesis-seed 자체 정합 검사 — 수치를 재계산하지는 않지만, 파일이 스스로
  // 주장하는 합계와 어긋나면 손상됐다는 뜻이므로 시작 전에 잡는다.
  if (genesis.pools.length !== genesis.totals.pools) {
    throw new Error(
      `genesis-seed 손상 의심: pools ${genesis.pools.length}개 ≠ totals.pools ${genesis.totals.pools}`
    );
  }
  let ttlSumCheck = 0n;
  for (const p of genesis.pools) ttlSumCheck += toWei(p.ttlWei, `${p.iso}.ttlWei`);
  if (ttlSumCheck !== toWei(genesis.totals.ttlWeiTotal, "totals.ttlWeiTotal")) {
    throw new Error("genesis-seed 손상 의심: Σttl Wei ≠ totals.ttlWeiTotal");
  }

  const deployer = await requireSigner(log);
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  // 배포 기록과 지금 붙어 있는 체인이 다르면, 이 주소들엔 아무것도 없다.
  if (chainId !== deployment.chainId) {
    throw new Error(
      `chainId 불일치: 배포 기록 ${deployment.chainId}, 현재 RPC ${chainId} — 네트워크를 확인하라`
    );
  }

  const routerAddr = deployment.contracts.router.address;
  const factoryAddr = deployment.contracts.factory.address;
  const wttlAddr = deployment.contracts.wttl.address;

  log(`  배포자    ${deployer.address}`);
  log(`  Router    ${routerAddr}`);
  log(`  Factory   ${factoryAddr}`);
  log(`  WTTL      ${wttlAddr}`);
  log(`  풀        ${genesis.pools.length}개`);

  // 배포 기록이 가리키는 주소에 코드가 실제로 있는지 — 기록만 믿지 않는다.
  for (const [name, addr] of [
    ["Router", routerAddr],
    ["Factory", factoryAddr],
    ["WTTL", wttlAddr],
  ] as const) {
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") throw new Error(`${name}(${addr}) 에 코드가 없다 — 배포 기록이 이 체인 것이 맞나`);
  }

  // ── 진행 기록 로드 (재개) ──────────────────────────────────────────────────
  let progress: SeedProgress;
  if (existsSync(progressFile)) {
    progress = loadJson<SeedProgress>(progressFile, "진행 기록");
    // 다른 배포/체인의 진행 기록을 이어받으면 완료 판정이 전부 거짓이 된다.
    if (
      progress.router.toLowerCase() !== routerAddr.toLowerCase() ||
      progress.chainId !== chainId
    ) {
      throw new Error(
        `진행 기록(${progressFile})이 다른 배포의 것이다 ` +
          `(기록 router ${progress.router}, 현재 ${routerAddr}). ` +
          `의도한 재배포라면 그 파일을 치우고 다시 실행하라.`
      );
    }
  } else {
    progress = { version: 1, network: netName, chainId, router: routerAddr, completed: {} };
  }

  const completedIsos = new Set(Object.keys(progress.completed));
  const pending = genesis.pools.filter((p) => !completedIsos.has(p.iso));
  const skippedCompleted: string[] = genesis.pools
    .filter((p) => completedIsos.has(p.iso))
    .map((p) => p.iso);

  if (skippedCompleted.length > 0) {
    log("");
    log(`  이미 완료된 풀 ${skippedCompleted.length}개 — 건너뛴다 (진행 기록 기준):`);
    log(`    ${skippedCompleted.join(", ")}`);
  }

  // ── 사전 검사 — 전 풀. 하나라도 실패하면 tx 0건으로 중단 ─────────────────
  log("");
  log(`  사전 검사 (대상 ${pending.length}풀)…`);

  const factory = (await ethers.getContractAt("TtlAmmFactory", factoryAddr, deployer)) as unknown as Contract;
  const errors: string[] = [];

  // 1) 각 토큰 잔액 ≥ tokenWei
  for (const p of pending) {
    const tokenWei = toWei(p.tokenWei, `${p.iso}.tokenWei`);
    const token = new ethers.Contract(p.token, ERC20_ABI, deployer);
    let bal: bigint;
    try {
      bal = (await token.balanceOf(deployer.address)) as bigint;
    } catch {
      errors.push(`${p.iso}: ${p.token} 에서 balanceOf 실패 — 토큰 컨트랙트가 맞는지 확인`);
      continue;
    }
    if (bal < tokenWei) {
      const shortWei = tokenWei - bal;
      errors.push(
        `${p.iso}: ${p.symbol} 잔액 부족 — 필요 ${ethers.formatUnits(tokenWei, p.decimals)}, ` +
          `보유 ${ethers.formatUnits(bal, p.decimals)}, 부족 ${ethers.formatUnits(shortWei, p.decimals)}` +
          (p.mintNeeded !== undefined
            ? ` (참고: genesis-seed 생성 시점 mintNeeded = ${p.mintNeeded} — 발행이 끝났는지 확인)`
            : "")
      );
    }
  }

  // 2) TTL 잔액 ≥ Σ(남은 풀 ttlWei) + 가스 여유
  //    가스 여유: 풀당 approve(~5만) + 첫 addLiquidityNative(Pair 배포 포함 ~330만)
  //    를 넉넉히 400만으로 잡는다. 추정이지 정밀값이 아니다 — 그래서 '여유'다.
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;
  const ttlNeeded = pending.reduce((acc, p) => acc + toWei(p.ttlWei, `${p.iso}.ttlWei`), 0n);
  const gasMargin = gasPrice * 4_000_000n * BigInt(Math.max(pending.length, 1));
  const ttlBalance = await ethers.provider.getBalance(deployer.address);
  log(
    `    TTL 필요 ${ethers.formatEther(ttlNeeded)} + 가스 여유 ≈ ${ethers.formatEther(gasMargin)}` +
      ` / 보유 ${ethers.formatEther(ttlBalance)}`
  );
  if (ttlBalance < ttlNeeded + gasMargin) {
    errors.push(
      `TTL 잔액 부족 — 필요 ${ethers.formatEther(ttlNeeded + gasMargin)} (시딩 ${ethers.formatEther(
        ttlNeeded
      )} + 가스 여유), 보유 ${ethers.formatEther(ttlBalance)}`
    );
  }

  // 3) 페어가 이미 존재하고 준비금이 있으면 — 건너뛰지 않고 명시적으로 보고,
  //    시작 전에 중단한다. 우리가 시딩한 풀은 진행 기록으로 걸러졌으므로,
  //    여기 걸리는 건 외부의(또는 기록이 유실된) 유동성이다. min==desired 라
  //    tx 는 어차피 revert 하겠지만, 알고도 보내는 것과 모르고 보내는 것은 다르다.
  for (const p of pending) {
    const pairAddr: string = await factory.getPair(wttlAddr, p.token);
    if (pairAddr === ethers.ZeroAddress) continue;
    const pair = (await ethers.getContractAt("TtlAmmPair", pairAddr, deployer)) as unknown as Contract;
    const [r0, r1] = (await pair.getReserves()) as [bigint, bigint, bigint];
    if (r0 > 0n || r1 > 0n) {
      const token0: string = await pair.token0();
      const [rTtl, rTok] = token0.toLowerCase() === wttlAddr.toLowerCase() ? [r0, r1] : [r1, r0];
      errors.push(
        `${p.iso}: 페어 ${pairAddr} 에 이미 준비금이 있다 ` +
          `(TTL ${ethers.formatEther(rTtl)}, ${p.symbol} ${ethers.formatUnits(rTok, p.decimals)}) — ` +
          `진행 기록에 없는 유동성이다. 출처를 확인하기 전에는 시딩하지 않는다.`
      );
    }
  }

  if (errors.length > 0) {
    log("");
    log(`[seed] ✗ 사전 검사 실패 ${errors.length}건 — tx 를 하나도 보내지 않고 중단한다:`);
    for (const e of errors) log(`    · ${e}`);
    log("");
    throw new Error("PRECHECK_FAILED");
  }
  log("    사전 검사 통과 — 토큰 잔액·TTL 잔액·기존 준비금 없음 확인");

  // ── 드라이런: 첫 N풀 tx 미리보기 후 종료 ─────────────────────────────────
  if (!opts.send) {
    const previewCount = opts.previewCount ?? 3;
    const preview = pending.slice(0, previewCount);
    const latest = await ethers.provider.getBlock("latest");
    const exampleDeadline = BigInt(latest?.timestamp ?? 0) + 1800n;
    log("");
    log(`  드라이런 미리보기 — 처음 ${preview.length}풀의 tx 내용 (실행 시 deadline 은 그때 블록시각+1800s):`);
    for (const p of preview) {
      const tokenWei = toWei(p.tokenWei, `${p.iso}.tokenWei`);
      const ttlWei = toWei(p.ttlWei, `${p.iso}.ttlWei`);
      log(`    [${p.iso}] ${p.symbol} (${p.token})`);
      log(`      ① ${p.symbol}.approve(${routerAddr}, ${tokenWei})`);
      log(`      ② Router.addLiquidityNative(`);
      log(`           token          = ${p.token}`);
      log(`           amountTokenDesired = ${tokenWei}`);
      log(`           amountTokenMin     = ${tokenWei}   // min == desired: 1 wei 도 양보 없음`);
      log(`           amountNativeMin    = ${ttlWei}   // 왜곡된 풀이면 revert 가 정답`);
      log(`           to             = ${deployer.address}`);
      log(`           deadline       ≈ ${exampleDeadline}`);
      log(`         ) value: ${ttlWei}  (${ethers.formatEther(ttlWei)} TTL)`);
      log(`      창세 가격 = tokenWei/ttlWei = ${formatRatio(tokenWei, ttlWei)} (genesis perTtl ${p.perTtl})`);
    }
    log("");
    log(`  (드라이런 — 실제 시딩하려면 --send 또는 BYEORIN_SEND=1. 총 ${pending.length}풀 × 2tx = ${pending.length * 2}tx)`);
    log("");
    return null;
  }

  // ── 실전: 풀 단위 실행 + 진행 기록 ─────────────────────────────────────────
  const router = (await ethers.getContractAt("TtlAmmRouter", routerAddr, deployer)) as unknown as Contract;
  const summary: SeedSummary = { seeded: [], skippedCompleted, failed: [], verify: [] };

  const saveProgress = (): void => {
    mkdirSync(dirname(progressFile), { recursive: true });
    writeFileSync(progressFile, JSON.stringify(progress, null, 2) + "\n", "utf8");
  };

  log("");
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const tokenWei = toWei(p.tokenWei, `${p.iso}.tokenWei`);
    const ttlWei = toWei(p.ttlWei, `${p.iso}.ttlWei`);
    const label = `[${i + 1}/${pending.length}] ${p.iso}`;
    try {
      const token = new ethers.Contract(p.token, ERC20_ABI, deployer);

      // ① 정확한 양만 approve. 이미 정확히 그 값이면 (이전 실행이 ② 직전에
      //    죽은 경우) tx 를 아낀다 — 그 외에는 항상 정확한 값으로 다시 쓴다.
      const allowance = (await token.allowance(deployer.address, routerAddr)) as bigint;
      let approveTx = "(기존 allowance 재사용)";
      if (allowance !== tokenWei) {
        const txA = await token.approve(routerAddr, tokenWei);
        await txA.wait();
        approveTx = txA.hash as string;
      }

      // ② deadline 은 매 풀마다 현재 블록시각 기준으로 새로 잡는다 —
      //    백수십 tx 가 오래 걸려도 앞에서 잡아둔 deadline 이 썩지 않게.
      const latest = await ethers.provider.getBlock("latest");
      const deadline = BigInt(latest?.timestamp ?? 0) + 1800n;
      const txB = await router.addLiquidityNative(
        p.token,
        tokenWei, // amountTokenDesired
        tokenWei, // amountTokenMin  — min == desired (위 머리주석 참조)
        ttlWei, //   amountNativeMin — min == desired
        deployer.address,
        deadline,
        { value: ttlWei }
      );
      const rcpt = await txB.wait();
      if (!rcpt) throw new Error("addLiquidityNative receipt 없음");

      const pairAddr: string = await factory.getPair(wttlAddr, p.token);
      progress.completed[p.iso] = {
        pair: pairAddr,
        approveTx,
        addTx: txB.hash as string,
        blockNumber: rcpt.blockNumber as number,
      };
      saveProgress(); // 풀마다 즉시 기록 — 다음 실행이 여기서 이어받는다
      summary.seeded.push(p.iso);
      log(`  ${label} OK — pair ${pairAddr} (tx ${txB.hash})`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      summary.failed.push({ iso: p.iso, reason });
      log(`  ${label} ✗ 실패 — ${reason}`);
      log(`      (계속 진행한다. 이 풀은 재실행 시 다시 시도된다.)`);
    }
  }

  // ── 검산: getReserves 를 읽어 창세 가격 확인 ──────────────────────────────
  // "132tx 다 보냈다"와 "각 풀의 준비금 비율이 perTtl 이다"는 다른 주장이다.
  // 후자를 체인에서 직접 읽어 확인한다. 검산 기준은 genesis-seed 의 wei 값
  // 그대로다 — 정확히 그 값이면 비율은 자동으로 맞는다 (가장 강한 형태).
  log("");
  log("  검산 — 완료된 전 풀의 getReserves 대조:");
  let verifyFailures = 0;
  for (const p of genesis.pools) {
    const done = progress.completed[p.iso];
    if (!done) continue;
    const tokenWei = toWei(p.tokenWei, `${p.iso}.tokenWei`);
    const ttlWei = toWei(p.ttlWei, `${p.iso}.ttlWei`);
    const pair = (await ethers.getContractAt("TtlAmmPair", done.pair, deployer)) as unknown as Contract;
    const token0: string = await pair.token0();
    const [r0, r1] = (await pair.getReserves()) as [bigint, bigint, bigint];
    const [reserveTtl, reserveToken] =
      token0.toLowerCase() === wttlAddr.toLowerCase() ? [r0, r1] : [r1, r0];
    const exactWei = reserveTtl === ttlWei && reserveToken === tokenWei;
    const ratioOk =
      (reserveToken * RATIO_SCALE) / reserveTtl === (tokenWei * RATIO_SCALE) / ttlWei;
    summary.verify.push({ iso: p.iso, pair: done.pair, reserveTtl, reserveToken, exactWei, ratioOk });
    if (exactWei) {
      log(
        `    ${p.iso.padEnd(4)} OK  reserve 정확 일치 — 가격 ${formatRatio(reserveToken, reserveTtl)} ` +
          `${p.symbol}/TTL (genesis perTtl ${p.perTtl})`
      );
    } else {
      verifyFailures++;
      log(
        `    ${p.iso.padEnd(4)} ${ratioOk ? "△ 비율은 일치하나 wei 불일치" : "✗ 창세 가격 불일치"} — ` +
          `reserve(TTL ${reserveTtl}, ${p.symbol} ${reserveToken}) vs genesis(${ttlWei}, ${tokenWei}). ` +
          `시딩 후 거래가 있었거나 외부 유동성이 섞였다.`
      );
    }
  }

  log("");
  log(
    `[seed] 완료 — 이번에 시딩 ${summary.seeded.length}, 기존 완료 ${summary.skippedCompleted.length}, ` +
      `실패 ${summary.failed.length}, 검산 불일치 ${verifyFailures} (총 ${genesis.pools.length}풀)`
  );
  if (summary.failed.length > 0) {
    log("  실패 목록 (재실행하면 이 풀들만 다시 시도한다):");
    for (const f of summary.failed) log(`    · ${f.iso}: ${f.reason}`);
  }
  log("");
  return summary;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const send = argv.includes("--send") || process.env.BYEORIN_SEND === "1";
  try {
    const summary = await runSeed({ send });
    // 실전에서 실패 풀이 있으면 종료 코드로도 알린다 — 파이프라인이 잡게.
    if (summary && summary.failed.length > 0) return 1;
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== "NO_DEPLOY_KEY" && msg !== "PRECHECK_FAILED") {
      console.error(`[seed] 실패: ${msg}`);
    }
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
