import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { extractBearerToken, isTokenEqual, TokenGuard } from './token.guard';

describe('extractBearerToken', () => {
  test('Bearer 형식에서 토큰 추출', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
  });

  test('형식 불일치·누락 시 null', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
  });
});

describe('isTokenEqual', () => {
  test('동일 토큰이면 true, 다르면 false', () => {
    expect(isTokenEqual('secret', 'secret')).toBe(true);
    expect(isTokenEqual('secret', 'wrong')).toBe(false);
    expect(isTokenEqual('secret', 'secret-longer')).toBe(false);
  });
});

describe('TokenGuard', () => {
  const EXPECTED = 'client-token';

  function createContext(authorization?: string, isPublic = false): {
    guard: TokenGuard;
    context: ExecutionContext;
  } {
    const config = { get: () => EXPECTED } as unknown as ConfigService;
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(isPublic),
    } as unknown as Reflector;
    const context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
    } as unknown as ExecutionContext;
    return { guard: new TokenGuard(config, reflector), context };
  }

  test('유효 토큰이면 통과', () => {
    const { guard, context } = createContext(`Bearer ${EXPECTED}`);
    expect(guard.canActivate(context)).toBe(true);
  });

  test('토큰 누락·불일치면 401', () => {
    expect(() => createContext(undefined).guard.canActivate(createContext(undefined).context)).toThrow(
      UnauthorizedException,
    );
    const wrong = createContext('Bearer wrong');
    expect(() => wrong.guard.canActivate(wrong.context)).toThrow(UnauthorizedException);
  });

  test('@Public 라우트는 토큰 없이 통과', () => {
    const { guard, context } = createContext(undefined, true);
    expect(guard.canActivate(context)).toBe(true);
  });
});
