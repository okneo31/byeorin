// 4-byte 셀렉터 디코더 단위 테스트.
// SELECTOR_TABLE 의 내용 보증 + decode4Byte() 의 경계 조건.

import { describe, expect, it } from 'vitest';
import { decode4Byte, SELECTOR_TABLE } from './selectors.js';

describe('SELECTOR_TABLE', () => {
  it('contains the 8 known ERC-20 / ERC-721 / ERC-1155 selectors', () => {
    // 표의 키가 정확히 우리가 기대하는 셀렉터 집합과 일치해야 한다.
    // (드리프트가 생기면 confirm popup 의 설명이 잠겨 사용자에게 잘못된 정보를 보여
    // 줄 수 있으므로, 표 자체의 무결성을 잠근다.)
    const expected = {
      // ERC-20
      '0xa9059cbb': 'transfer(address,uint256)',
      '0x23b872dd': 'transferFrom(address,address,uint256)',
      '0x095ea7b3': 'approve(address,uint256)',
      // ERC-721
      '0x42842e0e': 'safeTransferFrom(address,address,uint256)',
      '0xb88d4fde': 'safeTransferFrom(address,address,uint256,bytes)',
      '0xa22cb465': 'setApprovalForAll(address,bool)',
      // ERC-1155
      '0xf242432a': 'safeTransferFrom(address,address,uint256,uint256,bytes)',
      '0x2eb2c2d6': 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
    };
    expect(SELECTOR_TABLE).toStrictEqual(expected);
  });

  it('all selector keys are lowercase 4-byte hex strings', () => {
    for (const k of Object.keys(SELECTOR_TABLE)) {
      expect(k).toMatch(/^0x[0-9a-f]{8}$/);
    }
  });
});

describe('decode4Byte()', () => {
  it('decodes a known ERC-20 transfer selector', () => {
    // transfer(address,uint256) — 0xa9059cbb + 32B addr + 32B value
    const data =
      '0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa9604500000000000000000000000000000000000000000000000000000000000003e8';
    expect(decode4Byte(data)).toEqual({
      selector: '0xa9059cbb',
      signature: 'transfer(address,uint256)',
    });
  });

  it('decodes an ERC-20 approve selector', () => {
    expect(decode4Byte('0x095ea7b3deadbeef')).toEqual({
      selector: '0x095ea7b3',
      signature: 'approve(address,uint256)',
    });
  });

  it('decodes ERC-1155 safeBatchTransferFrom', () => {
    expect(decode4Byte('0x2eb2c2d6abc')).toEqual({
      selector: '0x2eb2c2d6',
      signature: 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
    });
  });

  it('returns signature=null for unknown selectors but still echoes the selector', () => {
    // 미상 — UI 가 "(알 수 없는 함수 호출)" 라벨을 붙일 수 있도록 selector 는 반환.
    expect(decode4Byte('0xdeadbeef00112233')).toEqual({
      selector: '0xdeadbeef',
      signature: null,
    });
  });

  it('normalizes uppercase hex to lowercase', () => {
    expect(decode4Byte('0xA9059CBB00')).toEqual({
      selector: '0xa9059cbb',
      signature: 'transfer(address,uint256)',
    });
  });

  it('returns null for null / undefined / non-string input', () => {
    expect(decode4Byte(null)).toBeNull();
    expect(decode4Byte(undefined)).toBeNull();
    expect(decode4Byte('' as unknown as string)).toBeNull();
    expect(decode4Byte(123 as unknown as string)).toBeNull();
  });

  it('returns null for input that does not start with 0x', () => {
    expect(decode4Byte('a9059cbb')).toBeNull();
    expect(decode4Byte('xx0xa9059cbb')).toBeNull();
  });

  it('returns null when data is shorter than 4 bytes', () => {
    expect(decode4Byte('0x')).toBeNull();        // empty
    expect(decode4Byte('0xa9059c')).toBeNull();  // 3 bytes
    expect(decode4Byte('0xa9059cb')).toBeNull(); // 3.5 bytes
  });

  it('returns null when first 4 bytes contain non-hex chars', () => {
    expect(decode4Byte('0xa9059cbz')).toBeNull();
    expect(decode4Byte('0x________')).toBeNull();
    expect(decode4Byte('0x  abcdef')).toBeNull();
  });
});
