#!/usr/bin/env node
/**
 * 벼린 거래소 창세 시딩 계획 생성기 (E-2).
 *
 * 결정(2026-07-29, 사용자 — 2차 정정 반영):
 *   - TTL **총 1,440,000,000 개**를 66 으로 나눈 몫이 풀당 시딩량이다.
 *     (1차에는 "풀당 1.44e9" 로 잘못 읽었다 — 총량이 맞다.)
 *   - **수량 산정 없이 임의 발행된 토큰은 제외한다.** 익스플로러의
 *     measured:false (basis "unmeasurable") 가 그 표식이다 — 실측 tETB·tMMK
 *     2 종. 창세 가격은 검증 가능한 근거 위에만 세운다.
 *   - 토큰 쪽은 창세 환율대로: token = perTtl × (풀당 TTL)
 *
 * 산출물:
 *   - genesis-seed.json (저장소 루트) — 풀별 시딩 수치 + 부족분 + 합계
 *
 * 재현성: 입력은 커밋된 rate-snapshot.json 하나다. 발행량 대조는 생성 시점의
 * scan.ttl1.top 응답을 스냅샷해 기록한다. 시딩 실행(seed 스크립트)은 이 파일의
 * 수치만 읽으므로, 제3자는 이 생성기를 다시 돌려 "창세 수치가 스냅샷에서
 * 기계적으로 나왔고 조작되지 않았다" 를 검증할 수 있다.
 *
 * 정밀도: perTtl 은 IEEE754 double 이다. 1e9 스케일 정수(PER_TTL_SCALE)로 올려
 * bigint 곱셈으로 wei 를 만든다 — 최대 perTtl(~3.5e5)×1e9 = 3.5e14 로 Math.round
 * 의 안전 정수(9e15) 안쪽이고, 비율 상대오차 ≤ ~1e-9 다. Math.round 는 플랫폼
 * 무관 결정적이므로 재현 가능하다.
 *
 * 사용: node scripts/build-genesis-seed.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** TTL 총 시딩량 — 결정값. 풀당은 ÷66 (몫, wei 바닥나눗셈). */
const SEED_TTL_TOTAL = 1_440_000_000;
const SEED_TTL_TOTAL_WEI = BigInt(SEED_TTL_TOTAL) * 10n ** 18n;
/** 결정 문구가 "66 으로 나눈다" 이므로 제외 후 풀 수(64)가 아니라 66 으로 나눈다.
 *  제외된 2 몫은 시딩하지 않고 남는다 — 총량을 몰래 재배분하지 않는다. */
const SEED_DIVISOR = 66n;
const SEED_TTL_WEI = SEED_TTL_TOTAL_WEI / SEED_DIVISOR; // 바닥 — 나머지는 미시딩 잔여
/** perTtl(double) → wei 비율 계산용 스케일. perTtl 최대 ~3.5e5 × 1e9 = 3.5e14 로
 *  Math.round 의 안전 정수(9e15) 안쪽 — 비율 상대오차 ≤ ~1e-9. */
const PER_TTL_SCALE = 10n ** 9n;

/** 앵커 날짜 — 고정 상수. 재실행해도 바뀌지 않아야 git diff 로 재현을 검증한다. */
const ANCHORED_AT = '2026-07-29';

const TOKENS_API = 'https://scan.ttl1.top/api/tokens?limit=500';

async function main() {
  const snap = JSON.parse(
    readFileSync(join(repoRoot, 'rate-snapshot.json'), 'utf8'),
  );

  // 발행량 대조용 — 생성 시점 스냅샷. 시딩 수치 자체에는 쓰지 않는다.
  process.stderr.write('[genesis] 발행량 조회 (scan.ttl1.top)…\n');
  const tokensBody = await (await fetch(TOKENS_API)).json();
  const infoByAddress = new Map(
    (tokensBody.tokens ?? []).map((t) => [
      String(t.address).toLowerCase(),
      {
        // supplyUnits 는 사람 단위(정수 문자열). wei 아님.
        issued: BigInt(t.supplyUnits ?? '0'),
        measured: t.measured === true,
        basis: String(t.basis ?? ''),
      },
    ]),
  );

  const pools = [];
  const excluded = [];
  let totalTokenShortfalls = 0;

  for (const r of snap.rates) {
    const info = infoByAddress.get(r.address.toLowerCase());
    if (!info || !info.measured) {
      // 수량 산정 없이 임의 발행된 토큰 — 창세 가격을 세울 근거가 없다.
      excluded.push({
        iso: r.iso,
        symbol: r.symbol,
        token: r.address,
        reason: info ? `measured:false (basis: ${info.basis})` : '익스플로러 목록에 없음',
      });
      continue;
    }

    // tokenWei = perTtl × ttlWei. double 을 1e9 스케일 정수로 올려 bigint 로 곱한다.
    const perTtlScaled = BigInt(Math.round(r.perTtl * Number(PER_TTL_SCALE)));
    const tokenWei = (perTtlScaled * SEED_TTL_WEI) / PER_TTL_SCALE;
    const tokenWhole = tokenWei / 10n ** 18n; // 사람 단위 참조 (바닥)

    const shortfall = tokenWhole > info.issued ? tokenWhole - info.issued : 0n;
    if (shortfall > 0n) totalTokenShortfalls++;

    pools.push({
      iso: r.iso,
      symbol: r.symbol,
      token: r.address,
      decimals: r.decimals,
      /** 창세 환율 — 검증용 참조. reserveToken/reserveTtl 이 이 값이 된다. */
      perTtl: r.perTtl,
      /** TTL 쪽 (wei 문자열). 전 풀 동일 = 1.44e9×10^18 ÷ 66 의 몫. */
      ttlWei: SEED_TTL_WEI.toString(),
      /** 토큰 쪽 (wei 문자열). */
      tokenWei: tokenWei.toString(),
      /** 사람 단위 참조값 (바닥). */
      tokenWhole: tokenWhole.toString(),
      /** 생성 시점 발행량(사람 단위)과 부족분. 부족분은 시딩 전 추가 발행 필요. */
      issuedAtGeneration: info.issued.toString(),
      mintNeeded: shortfall.toString(),
    });
  }

  const totalTtlWei = SEED_TTL_WEI * BigInt(pools.length);
  const unseededDustWei =
    SEED_TTL_TOTAL_WEI - SEED_TTL_WEI * SEED_DIVISOR + SEED_TTL_WEI * (SEED_DIVISOR - BigInt(pools.length));

  const out = {
    v: 1,
    anchoredAt: ANCHORED_AT,
    decision:
      'TTL 총 1,440,000,000 을 66 으로 나눈 몫이 풀당 시딩량 · measured:false(임의 발행) 토큰 제외 · 토큰 쪽 = perTtl × 풀당TTL (2026-07-29 사용자 결정, 2차 정정)',
    source: 'rate-snapshot.json (커밋된 앵커) — 시딩 수치의 유일한 입력',
    notes: [
      '이 파일이 시딩 실행의 유일한 입력이다. 실행 스크립트는 여기 수치를 계산 없이 그대로 쓴다.',
      'issuedAtGeneration/mintNeeded 는 생성 시점 참조값이다 — 시딩 전 발행이 끝나야 한다.',
      '제외 토큰(excluded)은 measured:false — 수량 산정 없는 임의 발행이라 창세 가격의 근거가 없다.',
      '풀당 몫은 총량÷66 의 바닥값이고, 제외된 몫과 나눗셈 잔여는 시딩하지 않는다 — 몰래 재배분하지 않는다.',
      '창세 직후 풀 가격 = perTtl. 스냅샷과 일치하므로 스나이핑할 불균형이 없다 (EXCHANGE.md §8).',
    ],
    totals: {
      pools: pools.length,
      excluded: excluded.length,
      ttlWeiPerPool: SEED_TTL_WEI.toString(),
      ttlWeiTotal: totalTtlWei.toString(),
      unseededWei: unseededDustWei.toString(),
      tokensNeedingMint: totalTokenShortfalls,
    },
    excluded,
    pools,
  };

  const outPath = join(repoRoot, 'genesis-seed.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  process.stderr.write(
    `[genesis] ${pools.length} 풀 (제외 ${excluded.length}) · 풀당 TTL ${(Number(SEED_TTL_WEI) / 1e18).toLocaleString()} · 추가 발행 필요 ${totalTokenShortfalls} 종\n[genesis] → ${outPath}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[genesis] 실패: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
