// 창세 리허설 — deploy.ts → seed.ts 를 하드햇 로컬 네트워크에서 실제로 돌린다.
//
// 이 테스트가 검증하는 것: "스크립트가 컴파일된다"가 아니라 "스크립트를 그대로
// 실행하면 genesis-seed.json 의 수치대로 풀이 채워진다". 실전(TTL 체인) 전의
// 유일한 리허설이므로, 수치는 실제 genesis-seed.json 의 처음 3개 풀을 그대로
// 쓰고 토큰 주소만 로컬 TestERC20 으로 바꾼다 — 금액 경로는 실전과 동일하다.

import { expect } from "chai";
import { ethers } from "hardhat";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runDeploy, type DeploymentRecord } from "../scripts/deploy";
import { runSeed, type GenesisSeedFile, type SeedSummary } from "../scripts/seed";
import { deployContract } from "./helpers";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

describe("창세 리허설 (E-3 통합) — deploy → seed, genesis-seed.json 처음 3풀", () => {
  it("실수치로 배포·시딩하면 각 풀의 getReserves 가 창세 가격과 정확히 일치한다", async function () {
    this.timeout(120_000);

    // ── 실수치 로드: genesis-seed.json 처음 3풀 (재계산 금지 — 파일 값 그대로) ──
    const real = JSON.parse(
      readFileSync(join(REPO_ROOT, "genesis-seed.json"), "utf8")
    ) as GenesisSeedFile;
    const pools = real.pools.slice(0, 3);
    expect(pools.length).to.equal(3);

    const [deployer] = await ethers.getSigners();

    // 시딩에 풀당 TTL 1.44e9 개 × 3 이 필요한데 하드햇 기본 잔액은 10e8 —
    // config 를 건드리지 않고 테스트 안에서 잔액만 올린다 (hardhat_setBalance).
    const ttlNeeded = pools.reduce((acc, p) => acc + BigInt(p.ttlWei), 0n);
    const funded = ttlNeeded + 1_000_000n * 10n ** 18n; // 가스 여유 100만 TTL
    await ethers.provider.send("hardhat_setBalance", [
      deployer.address,
      "0x" + funded.toString(16),
    ]);

    // ── 1. deploy.ts 흐름 — 드라이런이 아무것도 안 만드는 것부터 확인 ────────
    const tmp = mkdtempSync(join(tmpdir(), "byeorin-genesis-e2e-"));
    const deploymentsFile = join(tmp, "hardhat.json");
    const progressFile = join(tmp, "seed-progress.json");
    const silent = (): void => undefined; // 스크립트 출력은 실전용 — 테스트는 조용히

    const dry = await runDeploy({ send: false, deploymentsFile, log: silent });
    expect(dry, "드라이런은 배포하지 않는다").to.equal(null);
    expect(existsSync(deploymentsFile), "드라이런은 기록 파일을 만들지 않는다").to.equal(false);

    const record = (await runDeploy({ send: true, deploymentsFile, log: silent })) as DeploymentRecord;
    expect(record).to.not.equal(null);
    // 기록 파일이 실제로 쓰였고, 주소마다 코드가 존재한다 (tx 성공 ≠ 코드 존재)
    const written = JSON.parse(readFileSync(deploymentsFile, "utf8")) as DeploymentRecord;
    expect(written.contracts.router.address).to.equal(record.contracts.router.address);
    for (const c of [record.contracts.wttl, record.contracts.factory, record.contracts.router]) {
      expect(await ethers.provider.getCode(c.address)).to.not.equal("0x");
    }
    expect(written.compiler.solcVersion).to.equal("0.8.28");
    expect(written.compiler.evmVersion).to.equal("paris");
    expect(written.deployer).to.equal(deployer.address);

    // 재배포 방지: 기록이 있으면 force 없이는 중단한다
    let blocked = false;
    await runDeploy({ send: true, deploymentsFile, log: silent }).catch((e: Error) => {
      blocked = e.message === "DEPLOYMENT_EXISTS";
    });
    expect(blocked, "기존 배포 기록은 --force 없이 덮어쓸 수 없다").to.equal(true);

    // ── 2. 66종 t토큰 대역: TestERC20 3종을 genesis 수치(tokenWei)만큼 민팅 ──
    const seed: GenesisSeedFile = {
      totals: { pools: pools.length, ttlWeiTotal: ttlNeeded.toString() },
      pools: [],
    };
    for (const p of pools) {
      const token = await deployContract("TestERC20", BigInt(p.tokenWei)); // 민팅 → deployer
      seed.pools.push({ ...p, token: await token.getAddress() });
    }

    // ── 3. seed.ts 흐름 — 드라이런(사전 검사+미리보기) 후 실전 ───────────────
    const seedDry = await runSeed({
      send: false,
      deployment: record,
      seed,
      progressFile,
      log: silent,
    });
    expect(seedDry, "시딩 드라이런은 tx 를 보내지 않는다").to.equal(null);
    expect(existsSync(progressFile), "드라이런은 진행 기록을 만들지 않는다").to.equal(false);

    const summary = (await runSeed({
      send: true,
      deployment: record,
      seed,
      progressFile,
      log: silent,
    })) as SeedSummary;

    expect(summary.failed, "실패한 풀이 없어야 한다").to.deep.equal([]);
    expect(summary.seeded).to.deep.equal(pools.map((p) => p.iso));

    // ── 4. 검산 — 스크립트의 주장과 별개로, 체인에서 직접 읽어 대조 ──────────
    const factory = await ethers.getContractAt("TtlAmmFactory", record.contracts.factory.address);
    const wttlAddr = record.contracts.wttl.address;
    for (const p of seed.pools) {
      const pairAddr: string = await factory.getPair(wttlAddr, p.token);
      expect(pairAddr).to.not.equal(ethers.ZeroAddress);
      const pair = await ethers.getContractAt("TtlAmmPair", pairAddr);
      const token0: string = await pair.token0();
      const [r0, r1] = (await pair.getReserves()) as unknown as [bigint, bigint, bigint];
      const [reserveTtl, reserveToken] =
        token0.toLowerCase() === wttlAddr.toLowerCase() ? [r0, r1] : [r1, r0];

      // 준비금이 genesis-seed 의 wei 값과 정확히 일치 → 창세 가격
      // reserveToken/reserveTtl == tokenWei/ttlWei == perTtl 이 자동으로 성립한다.
      expect(reserveTtl, `${p.iso} TTL 준비금`).to.equal(BigInt(p.ttlWei));
      expect(reserveToken, `${p.iso} 토큰 준비금`).to.equal(BigInt(p.tokenWei));
    }
    // 스크립트 자체 검산 결과도 같은 결론이어야 한다
    expect(summary.verify.length).to.equal(3);
    for (const v of summary.verify) {
      expect(v.exactWei, `${v.iso} 검산 exactWei`).to.equal(true);
      expect(v.ratioOk, `${v.iso} 검산 ratioOk`).to.equal(true);
    }

    // ── 5. 재개 동작 — 재실행하면 3풀 모두 "완료됨" 으로 건너뛰고 tx 0건 ──────
    const rerun = (await runSeed({
      send: true,
      deployment: record,
      seed,
      progressFile,
      log: silent,
    })) as SeedSummary;
    expect(rerun.seeded).to.deep.equal([]);
    expect(rerun.skippedCompleted).to.have.members(pools.map((p) => p.iso));
    expect(rerun.failed).to.deep.equal([]);
    // 준비금이 그대로다 — 이중 시딩 없음
    for (const p of seed.pools) {
      const pairAddr: string = await factory.getPair(wttlAddr, p.token);
      const pair = await ethers.getContractAt("TtlAmmPair", pairAddr);
      const [r0, r1] = (await pair.getReserves()) as unknown as [bigint, bigint, bigint];
      const token0: string = await pair.token0();
      const [reserveTtl] = token0.toLowerCase() === wttlAddr.toLowerCase() ? [r0, r1] : [r1, r0];
      expect(reserveTtl, `${p.iso} 재실행 후 TTL 준비금 불변`).to.equal(BigInt(p.ttlWei));
    }
  });
});
