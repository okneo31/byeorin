// i18n.test.ts — i18n 코어 단위 테스트.
//
// 본 테스트는 React 와 무관한 순수 i18n 동작만 검증한다 (configureI18n + t).
// React 바인딩은 vitest+jsdom 추가 셋업이 필요하므로 별도 통합 단계에서 다룬다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetI18n,
  configureI18n,
  getLocale,
  onLocaleChange,
  setLocale,
  t,
  type Catalogs,
} from '../src/i18n.js';
import { catalogs as bundled } from '../src/messages/index.js';

const fixture: Catalogs = {
  ko: {
    'hello.world': '안녕 세상',
    'greet.with_name': '안녕하세요, {name} 님',
    'tokens.count': '{n}개의 토큰',
    'animals.count':
      '{n, plural, one {{n}마리의 동물} other {{n}마리의 동물}}',
  },
  en: {
    'hello.world': 'hello world',
    'greet.with_name': 'Hello, {name}',
    'tokens.count':
      '{n, plural, one {1 token} other {# tokens}}',
    'animals.count':
      '{n, plural, one {1 animal} other {# animals}}',
  },
};

describe('i18n — basic lookup', () => {
  beforeEach(() => {
    _resetI18n();
    configureI18n({ catalogs: fixture });
  });

  it('returns the catalog value for the current locale (ko default)', () => {
    expect(getLocale()).toBe('ko');
    expect(t('hello.world')).toBe('안녕 세상');
  });

  it('switches result when locale changes', () => {
    expect(t('hello.world')).toBe('안녕 세상');
    setLocale('en');
    expect(t('hello.world')).toBe('hello world');
  });

  it('falls back to ko when the en key is missing', () => {
    _resetI18n();
    configureI18n({
      catalogs: {
        ko: { 'only.ko': '한글만 있음' },
        en: {},
      },
      initialLocale: 'en',
    });
    expect(t('only.ko')).toBe('한글만 있음');
  });

  it('falls back to the key string when both locales are missing', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
  });
});

describe('i18n — variable interpolation', () => {
  beforeEach(() => {
    _resetI18n();
    configureI18n({ catalogs: fixture });
  });

  it('substitutes {var} with the provided value', () => {
    expect(t('greet.with_name', { name: '동지' })).toBe(
      '안녕하세요, 동지 님',
    );
  });

  it('substitutes numeric variables', () => {
    expect(t('tokens.count', { n: 3 })).toBe('3개의 토큰');
  });

  it('renders an empty string for an undefined variable', () => {
    // 미지정 시 그 위치는 빈 문자열. 사용자에게 "undefined" 노출 방지.
    expect(t('greet.with_name')).toBe('안녕하세요,  님');
  });

  it('passes through templates with no braces unchanged', () => {
    expect(t('hello.world')).toBe('안녕 세상');
  });
});

describe('i18n — plural', () => {
  beforeEach(() => {
    _resetI18n();
    configureI18n({ catalogs: fixture, initialLocale: 'en' });
  });

  it('uses the `one` branch when n === 1', () => {
    expect(t('tokens.count', { n: 1 })).toBe('1 token');
  });

  it('uses the `other` branch otherwise, substituting #', () => {
    expect(t('tokens.count', { n: 5 })).toBe('5 tokens');
    expect(t('tokens.count', { n: 0 })).toBe('0 tokens');
  });

  it('substitutes nested {var} inside a plural branch', () => {
    expect(t('animals.count', { n: 7 })).toBe('7 animals');
    setLocale('ko');
    expect(t('animals.count', { n: 2 })).toBe('2마리의 동물');
  });
});

describe('i18n — locale change listeners', () => {
  beforeEach(() => {
    _resetI18n();
    configureI18n({ catalogs: fixture });
  });

  it('fires listeners when the locale actually changes', () => {
    const fn = vi.fn();
    onLocaleChange(fn);
    setLocale('en');
    expect(fn).toHaveBeenCalledWith('en');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not fire when setLocale matches the current locale', () => {
    const fn = vi.fn();
    onLocaleChange(fn);
    setLocale('ko'); // same as initial
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns an unsubscribe function', () => {
    const fn = vi.fn();
    const off = onLocaleChange(fn);
    off();
    setLocale('en');
    expect(fn).not.toHaveBeenCalled();
  });

  it('isolates errors thrown by one listener from the next', () => {
    const ok = vi.fn();
    onLocaleChange(() => {
      throw new Error('boom');
    });
    onLocaleChange(ok);
    setLocale('en');
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('i18n — bundled catalog coverage (ko/en parity)', () => {
  beforeEach(() => {
    _resetI18n();
    configureI18n({ catalogs: bundled });
  });

  it('the English catalog defines every key the Korean catalog defines', () => {
    const koKeys = Object.keys(bundled.ko);
    const enKeys = new Set(Object.keys(bundled.en));
    const missing = koKeys.filter((k) => !enKeys.has(k));
    expect(missing, `Missing English keys: ${missing.join(', ')}`).toEqual([]);
  });

  it('the Korean catalog defines every key the English catalog defines', () => {
    const koKeys = new Set(Object.keys(bundled.ko));
    const enKeys = Object.keys(bundled.en);
    const missing = enKeys.filter((k) => !koKeys.has(k));
    expect(missing, `Missing Korean keys: ${missing.join(', ')}`).toEqual([]);
  });

  it('preserves the brand name in both locales', () => {
    expect(t('brand.name')).toBe('노동자의 지갑');
    setLocale('en');
    expect(t('brand.name')).toBe('노동자의 지갑');
    expect(t('brand.subtitle_en')).toBe("Worker's Wallet");
  });

  it('exposes an English error message for every shell-core error code', () => {
    setLocale('en');
    expect(t('errors.wordlist.mixed_characters')).not.toBe(
      'errors.wordlist.mixed_characters',
    );
    expect(t('errors.wallet.locked')).not.toBe('errors.wallet.locked');
    expect(t('errors.mnemonic.invalid')).not.toBe('errors.mnemonic.invalid');
    expect(t('errors.keystore.invalid_passphrase')).not.toBe(
      'errors.keystore.invalid_passphrase',
    );
  });
});

afterEach(() => {
  _resetI18n();
});
