/**
 * 프레임 송신 백프레셔 정책 — 영상과 제어 응답이 같은 소켓 큐를 공유하는 데서 오는 결정
 *
 * 소켓 송신 큐에 쌓인 영상 바이트만큼 commandResult·하트비트가 뒤로 밀린다.
 * 그래서 드롭 기준을 두 단계로 둔다
 */

/** 1단계 — 이 이상 밀리면 비키프레임 드롭 (화면은 다음 IDR에서 회복) */
export const FRAME_BACKPRESSURE_BYTES = 512 * 1024;

/**
 * 2단계 — 절대 상한. 키프레임도 드롭한다.
 * 이 값이 곧 제어 응답 지연의 상한선 (예: 2MB · 업링크 10Mbps ≈ 1.6초).
 * 상한이 없으면 업링크가 비트레이트에 못 미칠 때 큐가 단조 증가해 제어가 사실상 멈춘다
 */
export const FRAME_QUEUE_MAX_BYTES = 2 * 1024 * 1024;

export type FrameSendDecision = 'send' | 'drop_backpressure' | 'drop_queue_full';

/** 송신 큐 상태·프레임 종류로 전송 여부 판정 */
export function decideFrameSend(isKey: boolean, bufferedBytes: number): FrameSendDecision {
  if (bufferedBytes > FRAME_QUEUE_MAX_BYTES) return 'drop_queue_full';
  if (!isKey && bufferedBytes > FRAME_BACKPRESSURE_BYTES) return 'drop_backpressure';
  return 'send';
}
