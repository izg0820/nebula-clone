import { SetMetadata } from '@nestjs/common';

/** 인증 제외 라우트 표시용 메타데이터 키 */
export const IS_PUBLIC_KEY = 'isPublic';

/** 토큰 인증을 건너뛰는 라우트 지정 (예: /health) */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
