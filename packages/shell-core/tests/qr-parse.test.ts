// QR 디코드/파싱 단위 테스트.
//
// 디코드는 실제 QR 을 코드로 생성해 왕복시킨다 — 라이브러리 목이 아니라 진짜
// 비트맵을 통과시켜야 "읽힌다" 를 주장할 수 있다. PNG 인코딩/디코딩을 끼우지
// 않으려고 qrcode 의 모듈 비트맵을 직접 ImageData 로 부풀린다.

import { describe, expect, it } from 'vitest';
import { create as createQr } from 'qrcode';
import { EVM_CHAINS } from '@byeorin/wallet-sdk';
import { decodeQr, type RawImageData } from '../src/qr/decode.js';
import { parseScanned, evmChainKeyForId, baseUnitsToDecimalString } from '../src/qr/parse.js';
import { isValidAddressFor, isEip55Checksum } from '../src/qr/address.js';

const EVM_OK = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // EIP-55 정상
const EVM_LOWER = EVM_OK.toLowerCase();
const EVM_BAD_SUM = '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // 첫 글자만 뒤집음
const BTC_BECH32 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const BTC_P2PKH = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

function qrToImageData(text: string, scale = 4, quiet = 4): RawImageData {
  const qr = createQr(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const bits = qr.modules.data;
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!bits[y * size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (x + quiet) * scale + dx;
          const py = (y + quiet) * scale + dy;
          const i = (py * dim + px) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

describe('decodeQr — 실제 QR 왕복', () => {
  const samples = [
    EVM_OK,
    `bitcoin:${BTC_BECH32}?amount=0.001&label=byeorin`,
    `ethereum:${EVM_OK}@7777?value=2.5e18`,
    'BYEORIN QR ROUNDTRIP 1234567890',
  ];
  for (const s of samples) {
    it(`왕복: ${s.slice(0, 32)}`, () => {
      expect(decodeQr(qrToImageData(s))).toBe(s);
    });
  }

  it('QR 이 없는 이미지는 null', () => {
    const dim = 64;
    expect(
      decodeQr({ data: new Uint8ClampedArray(dim * dim * 4).fill(255), width: dim, height: dim }),
    ).toBeNull();
  });

  it('빈 이미지는 null', () => {
    expect(decodeQr({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toBeNull();
  });
});

describe('parseScanned — BIP21', () => {
  it('주소 + amount + label', () => {
    const r = parseScanned(`bitcoin:${BTC_BECH32}?amount=0.001&label=Luke`, 'btc');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('bip21');
    expect(r.address).toBe(BTC_BECH32);
    expect(r.amount).toBe('0.001');
    expect(r.label).toBe('Luke');
    expect(r.chainHint).toBe('btc');
  });

  it('스킴 대문자 허용', () => {
    expect(parseScanned(`BITCOIN:${BTC_P2PKH}`, 'btc').ok).toBe(true);
  });

  it('모르는 req- 파라미터는 거절', () => {
    const r = parseScanned(`bitcoin:${BTC_BECH32}?req-foo=1`, 'btc');
    expect(r).toMatchObject({ ok: false, code: 'required-param' });
  });

  it('BIP70 r= 도 거절', () => {
    expect(parseScanned(`bitcoin:${BTC_BECH32}?r=https://x`, 'btc')).toMatchObject({
      ok: false,
      code: 'required-param',
    });
  });

  it('X 지수 금액은 거절', () => {
    expect(parseScanned(`bitcoin:${BTC_BECH32}?amount=50X-3`, 'btc')).toMatchObject({
      ok: false,
      code: 'bad-amount',
    });
  });

  it('빈 주소는 거절', () => {
    expect(parseScanned('bitcoin:?amount=1', 'btc')).toMatchObject({
      ok: false,
      code: 'bad-address',
    });
  });

  it('선택 체인이 BTC 가 아니면 chain-mismatch', () => {
    expect(parseScanned(`bitcoin:${BTC_BECH32}`, 'evm:ttl')).toMatchObject({
      ok: false,
      code: 'chain-mismatch',
    });
  });

  it('모르는 non-req 파라미터는 warning 으로만', () => {
    const r = parseScanned(`bitcoin:${BTC_BECH32}?foo=1`, 'btc');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join()).toContain('foo');
  });
});

describe('parseScanned — EIP-681', () => {
  it('네이티브 송금 + chain_id', () => {
    const r = parseScanned(`ethereum:${EVM_OK}@7777?value=2.5e18`, 'evm:ttl');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.address).toBe(EVM_OK);
    expect(r.chainHint).toBe('evm:ttl');
    expect(r.amount).toBe('2.5');
  });

  it('pay- 접두 허용, value 없이', () => {
    const r = parseScanned(`ethereum:pay-${EVM_LOWER}`, 'evm:ethereum');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.amount).toBeUndefined();
  });

  it('정수 wei 도 표시 단위로', () => {
    const r = parseScanned(`ethereum:${EVM_OK}?value=1000000000000000000`, 'evm:ttl');
    expect(r.ok && r.amount).toBe('1');
  });

  it('/transfer 는 raw uint256 로만 보고 변환하지 않는다', () => {
    const token = '0x1111111111111111111111111111111111111111';
    const r = parseScanned(`ethereum:${token}/transfer?address=${EVM_OK}&uint256=1500000`, 'evm:ttl');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.address).toBe(EVM_OK);
    expect(r.tokenAddress).toBe(token);
    expect(r.tokenAmountRaw).toBe('1500000');
    expect(r.amount).toBeUndefined();
    expect(r.warnings.join()).toContain('uint256');
  });

  it('모르는 함수는 unsupported-scheme', () => {
    expect(parseScanned(`ethereum:${EVM_OK}/approve?address=${EVM_OK}`, 'evm:ttl')).toMatchObject({
      ok: false,
      code: 'unsupported-scheme',
    });
  });

  it('ENS 이름은 미지원', () => {
    expect(parseScanned('ethereum:byeorin.eth?value=1', 'evm:ttl')).toMatchObject({
      ok: false,
      code: 'bad-address',
    });
  });

  it('소수 wei 가 남는 금액은 거절', () => {
    expect(parseScanned(`ethereum:${EVM_OK}?value=1.5`, 'evm:ttl')).toMatchObject({
      ok: false,
      code: 'bad-amount',
    });
  });

  it('모르는 chain_id 는 warning + chainHint 없음', () => {
    const r = parseScanned(`ethereum:${EVM_OK}@999999`, 'evm:ttl');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chainHint).toBeUndefined();
    expect(r.warnings.join()).toContain('999999');
  });

  it('다른 체인 id 면 chain-mismatch', () => {
    expect(parseScanned(`ethereum:${EVM_OK}@1`, 'evm:ttl')).toMatchObject({
      ok: false,
      code: 'chain-mismatch',
    });
  });

  it('gas 파라미터는 무시 + warning', () => {
    const r = parseScanned(`ethereum:${EVM_OK}?value=0&gasPrice=100`, 'evm:ttl');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join()).toContain('gasPrice');
  });
});

describe('parseScanned — 평문 / 기타 스킴', () => {
  it('평문 EVM 주소', () => {
    const r = parseScanned(`  ${EVM_OK}\n`, 'evm:ttl');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe('raw');
  });

  it('빈 문자열', () => {
    expect(parseScanned('   ', 'evm:ttl')).toMatchObject({ ok: false, code: 'empty' });
  });

  it('체인이 다르면 거절 (BTC 주소를 EVM 자리에)', () => {
    expect(parseScanned(BTC_BECH32, 'evm:ttl')).toMatchObject({ ok: false, code: 'bad-address' });
  });

  it('solana: / wc: 등은 unsupported-scheme', () => {
    expect(parseScanned('solana:xyz', 'solana')).toMatchObject({
      ok: false,
      code: 'unsupported-scheme',
    });
    expect(parseScanned('wc:topic@2?relay-protocol=irn', 'evm:ttl')).toMatchObject({
      ok: false,
      code: 'unsupported-scheme',
    });
  });
});

describe('isValidAddressFor', () => {
  it('EVM — 체크섬 주장 주소는 EIP-55 검사', () => {
    expect(isEip55Checksum(EVM_OK)).toBe(true);
    expect(isEip55Checksum(EVM_BAD_SUM)).toBe(false);
    expect(isValidAddressFor('evm:ttl', EVM_OK)).toBe(true);
    expect(isValidAddressFor('evm:ttl', EVM_LOWER)).toBe(true);
    expect(isValidAddressFor('evm:ttl', EVM_BAD_SUM)).toBe(false);
    expect(isValidAddressFor('evm:ttl', '0x1234')).toBe(false);
  });

  it('BTC — base58 / bech32', () => {
    expect(isValidAddressFor('btc', BTC_P2PKH)).toBe(true);
    expect(isValidAddressFor('btc', BTC_BECH32)).toBe(true);
    expect(isValidAddressFor('btc', BTC_BECH32.toUpperCase())).toBe(true);
    expect(isValidAddressFor('btc', 'bc1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')).toBe(false);
    expect(isValidAddressFor('btc', '0BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(false);
  });

  it('cosmos — HRP 일치 요구', () => {
    const zion = 'zion1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu';
    expect(isValidAddressFor('cosmos:zion-1', zion, { bech32Prefix: 'zion' })).toBe(true);
    expect(isValidAddressFor('cosmos:zion-1', zion, { bech32Prefix: 'cosmos' })).toBe(false);
  });

  it('나머지 체인 형식', () => {
    expect(isValidAddressFor('xrp', 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv')).toBe(true);
    expect(isValidAddressFor('solana', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(true);
    expect(isValidAddressFor('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
    expect(
      isValidAddressFor('ton', 'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N'),
    ).toBe(true);
    expect(isValidAddressFor('sui', `0x${'a'.repeat(64)}`)).toBe(true);
    expect(isValidAddressFor('sui', '0xabc')).toBe(false);
  });
});

describe('chain_id 표는 wallet-sdk 레지스트리와 일치한다', () => {
  it('EVM_CHAINS 전 항목 왕복', () => {
    for (const [key, chain] of Object.entries(EVM_CHAINS)) {
      expect(evmChainKeyForId(chain.id)).toBe(`evm:${key}`);
    }
  });
});

describe('baseUnitsToDecimalString', () => {
  it('경계값', () => {
    expect(baseUnitsToDecimalString('0', 18)).toBe('0');
    expect(baseUnitsToDecimalString('1', 18)).toBe('0.000000000000000001');
    expect(baseUnitsToDecimalString('1000000000000000000', 18)).toBe('1');
    expect(baseUnitsToDecimalString('2500000000000000000', 18)).toBe('2.5');
  });
});
