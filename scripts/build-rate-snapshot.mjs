#!/usr/bin/env node
/**
 * 벼린 환율 스냅샷 생성기 — 1회성 앵커를 만든다.
 *
 * 무엇을 만드는가:
 *   TTL 생태계의 각국 통화토큰(tUSD, tJPY, …)이 TTL 에 대해 갖는 환율.
 *
 * 원칙: 1 TTL = 노동자 1일 품삯. 국적과 무관하다.
 *   그 나라에서 하루 품삯이 그 통화로 얼마인가 = 그 통화의 TTL 환율.
 *
 *   W_c = 명목GDP_c(자국통화) / 인구_c / 365
 *   1 TTL = W_c 단위의 t{c}
 *
 * 왜 명목 GDP 인가:
 *   실질 GDP 는 인플레이션을 제거한 지표인데, 우리가 재려는 것이 바로 그
 *   인플레이션이다. 실질을 쓰면 화폐를 무한정 찍어도 TTL 대비 가치가 안 떨어진다.
 *   또 실질은 나라마다 기준연도가 달라 국가 간 비교가 성립하지 않는다.
 *
 * 왜 자국통화 단위인가:
 *   달러 환산 GDP 를 쓰면 시장환율이 이미 곱해진 값이라, 배제하려던 시장환율이
 *   뒷문으로 들어온다. World Bank 지표 NY.GDP.MKTP.CN 이 정확히 "current LCU"
 *   (당해가격·자국통화) 다.
 *
 * 이 스크립트는 **한 번만** 돌린다. 산출물(rate-snapshot.json)이 앵커이고,
 * 그 뒤로 외부 데이터를 다시 보지 않는다 — BTC 페깅을 해제한 것과 같은 방식이다.
 * 스크립트를 저장소에 두는 이유는 제3자가 같은 입력으로 같은 값을 재현해
 * 검증할 수 있어야 하기 때문이다.
 *
 * 사용: node scripts/build-rate-snapshot.mjs [--out <path>]
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const WB = 'https://api.worldbank.org/v2';
const GDP_LCU = 'NY.GDP.MKTP.CN'; // GDP (current LCU) — 명목, 자국통화
const POPULATION = 'SP.POP.TOTL';
const TOKENS_API = 'https://scan.ttl1.top/api/tokens?limit=500';

/** 1 년을 며칠로 나눌 것인가. TTL 페그(연봉÷365)와 맞춘다. */
const DAYS_PER_YEAR = 365;

/**
 * TTL Scan 국가명 → World Bank iso3.
 * WB 는 "Korea, Rep." 같은 자체 표기를 쓴다. 이름 매칭은 계속 어긋나므로 못 박는다.
 */
const ISO3_ALIAS = {
  'Euro Area': 'EMU',
  'Hong Kong': 'HKG',
  'South Korea': 'KOR',
  Russia: 'RUS',
  Turkey: 'TUR',
  Egypt: 'EGY',
};

/**
 * 통화동맹 — 여러 주권국이 한 통화를 함께 쓰는 경우.
 *
 * 한 나라 값만 쓰면 그 통화의 하루 품삯이 아니라 그 나라의 하루 품삯이 된다.
 * 회원국 GDP 를 합산하고 인구도 합산한다 — 전부 자국통화가 같으므로 GDP 를
 * 그대로 더할 수 있다.
 *
 * 여기 없는 통화(AUD·CHF·DKK·INR·NZD·USD·ZAR 등)도 소국에서 통용되지만
 * 발행국이 압도적이라 합산하지 않는다.
 */
const CURRENCY_UNIONS = {
  // 유로존 20개국. WB 의 EMU 집계에는 자국통화 GDP 가 없어 직접 더한다.
  EUR: [
    'AUT', 'BEL', 'HRV', 'CYP', 'EST', 'FIN', 'FRA', 'DEU', 'GRC', 'IRL',
    'ITA', 'LVA', 'LTU', 'LUX', 'MLT', 'NLD', 'PRT', 'SVK', 'SVN', 'ESP',
  ],
  // 서아프리카 CFA 프랑 8개국. 토큰 목록은 코트디부아르 하나에만 연결돼 있는데,
  // 그대로 쓰면 XOF 가 아니라 코트디부아르의 품삯이 된다.
  XOF: ['BEN', 'BFA', 'CIV', 'GNB', 'MLI', 'NER', 'SEN', 'TGO'],
};

/**
 * 앵커를 취득한 날. **실행 시각이 아니라 고정 상수다.**
 * 실행할 때마다 바뀌는 값을 넣으면 "다시 돌려서 git diff 가 비는지" 로 재현을
 * 검증할 수 없게 된다.
 */
const ANCHORED_AT = '2026-07-29';

/**
 * World Bank 가 다루지 않는 나라를 IMF 로 채운다. 현재는 대만뿐.
 * 키는 TTL Scan 국가명, 값은 IMF DataMapper 국가코드.
 */
const IMF_FALLBACK = { Taiwan: 'TWN' };

const IMF = 'https://www.imf.org/external/datamapper/api/v1';

/**
 * IMF 에서 **자국통화** 명목 GDP 와 인구를 얻는다.
 *
 * IMF DataMapper 에는 자국통화 GDP 계열이 아예 없다 — 달러(NGDPD)와 PPP 뿐이다.
 * 달러 환산값은 시장환율이 이미 곱해진 값이라 쓸 수 없다. 그래서 항등식으로
 * 되돌린다:
 *
 *   PPPGDP(국제달러) × PPPEX(자국통화/국제달러) = 자국통화 GDP
 *
 * PPP 환산율은 물가 기반이지 시장환율이 아니므로 이 체계의 전제를 깨지 않는다.
 * 실측 검증(2026-07-29): 한국·일본·미국·독일에서 World Bank 자국통화 GDP 와
 * 오차 0.00~0.02% 로 일치했다.
 */
async function imfLocalGdpAndPop(code, years) {
  const get = async (ind) => {
    const res = await fetch(`${IMF}/${ind}/${code}`);
    if (!res.ok) return null;
    const body = await res.json();
    return body?.values?.[ind]?.[code] ?? null;
  };
  const [pppGdp, pppEx, pop] = await Promise.all([get('PPPGDP'), get('PPPEX'), get('LP')]);
  if (!pppGdp || !pppEx || !pop) return null;
  for (const y of years) {
    const g = pppGdp[y];
    const x = pppEx[y];
    const p = pop[y];
    if (typeof g === 'number' && typeof x === 'number' && typeof p === 'number' && p > 0) {
      return {
        // PPPGDP 는 10억 국제달러, LP 는 백만 명 단위다.
        gdp: {
          value: g * 1e9 * x,
          year: y,
          synthetic: 'IMF PPPGDP × PPPEX 로 자국통화 GDP 복원 (World Bank 미수록국)',
        },
        pop: { value: p * 1e6, year: y },
        year: y,
      };
    }
  }
  return null;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');

async function wbIndicator(indicator, year) {
  const out = new Map();
  for (let page = 1; page <= 4; page++) {
    const url = `${WB}/country/all/indicator/${indicator}?format=json&date=${year}&per_page=400&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`World Bank ${indicator} ${year}: HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body) || !body[1]) break;
    for (const row of body[1]) {
      if (row.value === null) continue;
      out.set(row.countryiso3code, {
        name: row.country?.value ?? '',
        value: Number(row.value),
        year: row.date,
      });
    }
    if (!body[0] || page >= (body[0].pages ?? 1)) break;
  }
  return out;
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const outPath =
    outIdx !== -1 && process.argv[outIdx + 1]
      ? resolve(process.argv[outIdx + 1])
      : join(repoRoot, 'rate-snapshot.json');

  process.stderr.write('[rates] TTL 토큰 목록…\n');
  const tokensBody = await (await fetch(TOKENS_API)).json();
  const tokens = tokensBody.tokens ?? [];
  if (tokens.length === 0) throw new Error('토큰 목록이 비었다');

  process.stderr.write('[rates] World Bank 명목GDP(자국통화) · 인구…\n');
  // 2025 를 우선하고 없으면 2024 로 내려간다. 어느 연도를 썼는지 항목마다 기록한다.
  const [gdp25, gdp24, pop25, pop24] = await Promise.all([
    wbIndicator(GDP_LCU, 2025),
    wbIndicator(GDP_LCU, 2024),
    wbIndicator(POPULATION, 2025),
    wbIndicator(POPULATION, 2024),
  ]);

  const byName = new Map();
  for (const [iso3, v] of [...gdp25, ...gdp24]) byName.set(norm(v.name), iso3);

  /**
   * GDP 와 인구를 **같은 연도로 짝지어** 고른다.
   *
   * 각각 최신을 따로 고르면 2024 GDP ÷ 2025 인구 같은 조합이 나온다. 분자와
   * 분모의 기준 시점이 다르면 1인당 값이 그만큼 왜곡된다.
   */
  const pickPair = (iso3) => {
    for (const [g, p, year] of [
      [gdp25, pop25, '2025'],
      [gdp24, pop24, '2024'],
    ]) {
      const gv = g.get(iso3);
      const pv = p.get(iso3);
      if (gv && pv && pv.value > 0) return { gdp: gv, pop: pv, year };
    }
    return null;
  };

  /** 통화동맹 합산 — 회원국 GDP 와 인구를 같은 연도로 더한다. */
  const unionPair = (members) => {
    for (const [g, p, year] of [
      [gdp25, pop25, '2025'],
      [gdp24, pop24, '2024'],
    ]) {
      let gsum = 0;
      let psum = 0;
      let ok = true;
      for (const m of members) {
        const gv = g.get(m);
        const pv = p.get(m);
        if (!gv || !pv) { ok = false; break; }
        gsum += gv.value;
        psum += pv.value;
      }
      if (ok && psum > 0) {
        return {
          gdp: { value: gsum, year, synthetic: `회원국 ${members.length}개국 GDP 합산` },
          pop: { value: psum, year },
          year,
        };
      }
    }
    return null;
  };

  const rates = [];
  const unresolved = [];

  for (const t of tokens) {
    const iso3 = ISO3_ALIAS[t.country] ?? byName.get(norm(t.country)) ?? null;
    const union = CURRENCY_UNIONS[t.iso];
    const imfCode = IMF_FALLBACK[t.country];
    // World Bank 우선. 거기 없는 나라만 IMF 로 채운다 — 출처를 하나로 몰아
    // 두는 편이 재현이 쉽고, 섞이는 지점을 최소화한다.
    const pair = union
      ? unionPair(union)
      : iso3
        ? pickPair(iso3)
        : imfCode
          ? await imfLocalGdpAndPop(imfCode, ['2025', '2024'])
          : null;
    const gdp = pair?.gdp ?? null;
    const pop = pair?.pop ?? null;

    if ((!iso3 && !union && !imfCode) || !gdp || !pop || !(pop.value > 0)) {
      // 추측하지 않는다. 데이터가 없으면 그 토큰은 가치 미표시로 남긴다 —
      // 틀린 환율을 보여주는 것보다 낫다.
      unresolved.push({
        symbol: t.symbol,
        iso: t.iso,
        country: t.country,
        reason:
          !iso3 && !union && !imfCode
            ? 'World Bank·IMF 어디에도 없음'
            : !gdp
              ? '명목GDP 없음'
              : '인구 없음',
      });
      continue;
    }

    const perTtl = gdp.value / pop.value / DAYS_PER_YEAR;
    rates.push({
      symbol: t.symbol,
      iso: t.iso,
      address: t.address,
      decimals: t.decimals,
      country: t.country,
      ...(union ? { iso3Members: [...union] } : { iso3: iso3 ?? imfCode }),
      // 1 TTL = perTtl 단위의 이 토큰.
      perTtl,
      inputs: {
        gdpLocal: gdp.value,
        gdpYear: gdp.year,
        population: pop.value,
        populationYear: pop.year,
        ...(gdp.synthetic ? { gdpSynthetic: gdp.synthetic } : {}),
      },
    });
  }

  rates.sort((a, b) => a.iso.localeCompare(b.iso));

  const snapshot = {
    v: 1,
    anchoredAt: ANCHORED_AT,
    principle:
      '1 TTL = 노동자 1일 품삯. 국적과 무관하다. 그 나라의 하루 품삯이 그 통화로 얼마인가가 곧 환율이다.',
    formula: 'perTtl = 명목GDP(자국통화) / 인구 / 365   →   1 TTL = perTtl 단위의 t{iso}',
    daysPerYear: DAYS_PER_YEAR,
    sources: {
      gdp: `World Bank ${GDP_LCU} (GDP, current LCU — 명목·자국통화)`,
      population: `World Bank ${POPULATION}`,
      tokens: TOKENS_API,
      api: WB,
      imfFallback: `IMF DataMapper — World Bank 미수록국만. PPPGDP × PPPEX 로 자국통화 GDP 복원 (${IMF})`,
    },
    notes: [
      '이 파일은 앵커다. 한 번 만들고 그 뒤로 외부 데이터를 다시 보지 않는다.',
      '실질 GDP 를 쓰지 않는 이유: 인플레이션을 제거한 지표라 통화 남발이 가치에 반영되지 않는다.',
      '달러 환산 GDP 를 쓰지 않는 이유: 시장환율이 이미 곱해진 값이다.',
      'TTL 의 외부 시세(BTC 앵커)와는 별개 트랙이다. 여기에는 등장하지 않는다.',
      '데이터가 없는 통화는 추측하지 않고 unresolved 에 남긴다 — 지갑은 가치 미표시로 처리한다.',
    ],
    rates,
    unresolved,
  };

  writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  // SDK 가 번들에 싣는 사본. 루트 JSON 은 사람이 눈으로 검증하는 산출물이고,
  // 이쪽은 코드가 import 하는 사본이다 — 둘은 이 스크립트 한 번의 실행에서
  // 같이 나오므로 어긋날 수 없다.
  const tsPath = join(repoRoot, 'packages', 'wallet-sdk', 'src', 'rates', 'snapshot.ts');
  const ts =
    `// 이 파일은 생성물이다. 손으로 고치지 마라.\n` +
    `// 생성: node scripts/build-rate-snapshot.mjs\n` +
    `//\n` +
    `// ${snapshot.principle}\n` +
    `// ${snapshot.formula}\n` +
    `//\n` +
    `// 앵커다 — 한 번 만들고 그 뒤로 외부 데이터를 다시 보지 않는다.\n` +
    `// 루트의 rate-snapshot.json 과 같은 실행에서 함께 나온 사본이다.\n\n` +
    `import type { RateSnapshot } from './types.js';\n\n` +
    `export const RATE_SNAPSHOT: RateSnapshot = ${JSON.stringify(snapshot, null, 2)} as const;\n`;
  writeFileSync(tsPath, ts, 'utf8');
  process.stderr.write(`[rates] → ${tsPath}\n`);

  process.stderr.write(
    `[rates] ${rates.length}/${tokens.length} 산출 · 미해결 ${unresolved.length}\n` +
      `[rates] → ${outPath}\n`,
  );
  for (const u of unresolved) {
    process.stderr.write(`   미해결: ${u.symbol}(${u.iso}) ${u.country} — ${u.reason}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`[rates] 실패: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
