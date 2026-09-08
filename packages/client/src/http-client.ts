/**
 * 전송 계층 — 브라우저(웹 콘솔)·Node 18+(CLI) 양쪽에서 동작.
 * DOM Response/RequestInit를 직접 참조하지 않는 구조적 타입으로 선언해
 * @types/node(undici-types)와 lib.dom의 fetch 선언 충돌을 회피
 */

/** 서버 명령 프록시 타임아웃(15초)보다 길게 */
export const DEFAULT_TIMEOUT_MS = 20_000;

export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface HttpRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** 전송 계층 주입점 — 테스트·프록시·계측용 */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

/** 기본 구현 — globalThis 경유 호출 (unbound fetch 참조는 브라우저에서 Illegal invocation) */
export function defaultFetch(url: string, init: HttpRequestInit): Promise<HttpResponseLike> {
  return globalThis.fetch(url, init);
}
