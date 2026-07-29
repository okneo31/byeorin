#!/usr/bin/env node
/**
 * 벼린 거래소 창세 시딩 계획 생성기 (E-2).
 *
 * 결정(2026-07-29, 사용자):
 *   - 풀당 TTL **1,440,000,000 개 고정** (66 풀 전부 동일)
 *   - 토큰 쪽은 창세 환율(rate-snapshot 의 perTtl)대로 채운다:
 *       token = 1,440,000,000 × perTtl
 *   - 발행량(M2/10)을 넘는 41 종은 **추가 발행으로 채운다** — 발행자 결정.
 *     이 스크립트는 부족분을 계산해 mintNeeded 로 명시한다 (숨기지 않는다).
 *
 * 산출물:
 *   - genesis-seed.json (저장소 루트) — 풀별 시딩 수치 + 부족분 + 합계
 *
 * 재현성: 입력은 커밋된 rate-snapshot.json 하나다. 발행량 대조는 생성 시점의
 * scan.ttl1.top 응답을 스냅샷해 기록한다. 시딩 실행(seed 스크립트)은 이 파일의
 * 수치만 읽으므로, 제3자는 이 생성기를 다시 돌려 "창세 수치가 스냅샷에서
 * 기계적으로 나왔고 조작되지 않았다" 를 검증할 수 있다.
 *
 * 정밀도: perTtl 은 IEEE754 double 이다. 최대 perTtl(tVND 346,450)×1.44e9 ≈
 * 4.99e14 로 2^53(9e15) 안쪽이라 정수부가 정확하고, Math.round 는 플랫폼
 * 무관 결정적이다. wei 변환은 그 정수에 10^18 을 곱하는 bigint 연산이다.
 *
 * 사용: node scripts/build-genesis-seed.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 풀당 TTL — 고정 결정값. 사람 단위(1 TTL = 10^18 wei). */
const SEED_TTL_PER_POOL = 1_440_000_000;
const SEED_TTL_WEI = BigInt(SEED_TTL_PER_POOL) * 10n ** 18n;

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
  const supplyByAddress = new Map(
    (tokensBody.tokens ?? []).map((t) => [
      String(t.address).toLowerCase(),
      // supplyUnits 는 사람 단위(정수 문자열). wei 아님.
      BigInt(t.supplyUnits ?? '0'),
    ]),
  );

  const pools = [];
  let totalTokenShortfalls = 0;

  for (const r of snap.rates) {
    // token = SEED × perTtl. 정수 토큰 단위로 반올림 후 wei 로.
    const tokenWhole = Math.round(r.perTtl * SEED_TTL_PER_POOL);
    if (!Number.isSafeInteger(tokenWhole)) {
      // 여기 걸리면 수치가 2^53 을 넘은 것 — 조용히 잘리면 창세 가격이 왜곡된다.
      throw new Error(`genesis: ${r.iso} 시딩량이 안전 정수 범위를 벗어남`);
    }
    const tokenWei = BigInt(tokenWhole) * 10n ** 18n;

    const issued = supplyByAddress.get(r.address.toLowerCase()) ?? 0n;
    const shortfall = BigInt(tokenWhole) > issued ? BigInt(tokenWhole) - issued : 0n;
    if (shortfall > 0n) totalTokenShortfalls++;

    pools.push({
      iso: r.iso,
      symbol: r.symbol,
      token: r.address,
      decimals: r.decimals,
      /** 창세 환율 — 검증용 참조. reserveToken/reserveTtl 이 이 값이 된다. */
      perTtl: r.perTtl,
      /** TTL 쪽 (wei 문자열). 전 풀 동일. */
      ttlWei: SEED_TTL_WEI.toString(),
      /** 토큰 쪽 (wei 문자열). */
      tokenWei: tokenWei.toString(),
      /** 사람 단위 참조값. */
      ttlWhole: SEED_TTL_PER_POOL,
      tokenWhole,
      /** 생성 시점 발행량(사람 단위)과 부족분. 부족분은 시딩 전 추가 발행 필요. */
      issuedAtGeneration: issued.toString(),
      mintNeeded: shortfall.toString(),
    });
  }

  const totalTtlWei = SEED_TTL_WEI * BigInt(pools.length);

  const out = {
    v: 1,
    anchoredAt: ANCHORED_AT,
    decision:
      '풀당 TTL 1,440,000,000 고정 · 토큰 쪽 = perTtl × 1.44e9 · 부족분은 추가 발행 (2026-07-29 사용자 결정)',
    source: 'rate-snapshot.json (커밋된 앵커) — 시딩 수치의 유일한 입력',
    notes: [
      '이 파일이 시딩 실행의 유일한 입력이다. 실행 스크립트는 여기 수치를 계산 없이 그대로 쓴다.',
      'issuedAtGeneration/mintNeeded 는 생성 시점 참조값이다 — 시딩 전 발행이 끝나야 한다.',
      'mintNeeded > 0 인 토큰은 공표된 M2/10 발행 기준을 넘는다. 발행자 결정으로 확정됐다.',
      '창세 직후 풀 가격 = perTtl. 스냅샷과 일치하므로 스나이핑할 불균형이 없다 (EXCHANGE.md §8).',
    ],
    totals: {
      pools: pools.length,
      ttlWeiTotal: totalTtlWei.toString(),
      ttlWholeTotal: SEED_TTL_PER_POOL * pools.length,
      tokensNeedingMint: totalTokenShortfalls,
    },
    pools,
  };

  const outPath = join(repoRoot, 'genesis-seed.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  process.stderr.write(
    `[genesis] ${pools.length} 풀 · TTL 총 ${(SEED_TTL_PER_POOL * pools.length).toLocaleString()} · 추가 발행 필요 ${totalTokenShortfalls} 종\n[genesis] → ${outPath}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[genesis] 실패: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
