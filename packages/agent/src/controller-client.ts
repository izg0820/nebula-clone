import { CommandOutcome, DeviceAction } from '@nebula/shared';
import { logger } from './logger';

/** Controller HTTP 응답 대기 상한 — 서버 명령 타임아웃(15초)보다 짧게 */
const CONTROLLER_TIMEOUT_MS = 10_000;

/** 액션 → Controller HTTP 경로·본문 매핑 */
interface ControllerRequest {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

function toControllerRequest(action: DeviceAction): ControllerRequest {
  if (action.kind === 'tap') return { path: '/tap', body: { x: action.x, y: action.y } };
  if (action.kind === 'swipe') {
    return {
      path: '/swipe',
      body: {
        fromX: action.fromX,
        fromY: action.fromY,
        toX: action.toX,
        toY: action.toY,
        durationMs: action.durationMs,
      },
    };
  }
  if (action.kind === 'typeText') return { path: '/type', body: { text: action.text } };
  if (action.kind === 'screenshot') return { path: '/screenshot', body: {} };
  return { path: '/ui', body: {} };
}

/**
 * 기기별 Controller(XCUITest 러너) HTTP 클라이언트
 * Controller는 상시 구동(pre-warm) 전제 — 세션 개념 없음
 */
export class ControllerClient {
  constructor(private readonly baseUrl: string) {}

  async execute(action: DeviceAction): Promise<CommandOutcome> {
    const request = toControllerRequest(action);
    try {
      const response = await fetch(`${this.baseUrl}${request.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(CONTROLLER_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { ok: false, error: `controller HTTP ${response.status}` };
      }
      const result: unknown = await response.json();
      return { ok: true, result };
    } catch (error) {
      logger.warn({ err: error, baseUrl: this.baseUrl }, 'Controller 호출 실패');
      return { ok: false, error: 'controller 연결 실패 또는 시간 초과' };
    }
  }
}
