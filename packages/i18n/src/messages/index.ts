// messages/index.ts — 로케일별 카탈로그를 한 곳에서 묶어 export.
//
// 앱 부팅 시 `configureI18n({ catalogs })` 에 그대로 넘겨 쓸 수 있다.

import type { Catalogs } from '../i18n.js';
import { ko } from './ko.js';
import { en } from './en.js';

export { ko, en };

/**
 * 모든 로케일을 한 객체로 묶은 기본 카탈로그.
 *
 * 영어/한국어 두 카탈로그가 같은 키 집합을 갖도록 노력하지만, 누락된 키가 있어도
 * `t()` 가 한국어 → 키 문자열 순으로 자동 폴백한다.
 */
export const catalogs: Catalogs = { ko, en };
