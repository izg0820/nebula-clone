import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from './dto/error-response.dto';

/** 보호 라우트 공통 오류 — 컨트롤러 클래스에 1회 부착 */
export function ApiAuthErrors(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiResponse({ status: 401, type: ErrorResponseDto, description: '토큰 없음·불일치' }),
    ApiResponse({ status: 429, type: ErrorResponseDto, description: '요청 과다 (rate limit)' }),
  );
}

/** 기기 대상 라우트 오류 — 조회·점유·해제·keepalive */
export function ApiDeviceErrors(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiResponse({ status: 404, type: ErrorResponseDto, description: '기기 없음' }),
    ApiResponse({ status: 409, type: ErrorResponseDto, description: '점유 충돌·가용 기기 없음' }),
  );
}

/** 명령 프록시 라우트 오류 — 검증·점유·터널·기기 응답 */
export function ApiCommandErrors(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiResponse({ status: 400, type: ErrorResponseDto, description: 'DTO 검증 실패·미지원 액션' }),
    ApiResponse({ status: 403, type: ErrorResponseDto, description: '점유자 불일치' }),
    ApiResponse({ status: 404, type: ErrorResponseDto, description: '기기 없음' }),
    ApiResponse({ status: 409, type: ErrorResponseDto, description: '기기 오프라인' }),
    ApiResponse({ status: 502, type: ErrorResponseDto, description: 'Agent 미연결·기기 명령 실패' }),
    ApiResponse({ status: 504, type: ErrorResponseDto, description: '기기 응답 시간 초과' }),
  );
}
