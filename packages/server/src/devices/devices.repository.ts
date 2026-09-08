import {
  Device,
  OccupyFilter,
  RegisterDeviceInput,
  ReleaseResult,
  RenewResult,
} from './device.types';

/** DI 토큰 */
export const DEVICES_REPOSITORY = Symbol('DEVICES_REPOSITORY');

/**
 * 디바이스 레지스트리 저장소 인터페이스
 * 시작은 SQLite 구현 — 확장 시 Redis 등으로 교체 가능하도록 분리
 */
export interface DevicesRepository {
  /** Agent 등록 디바이스 일괄 upsert (online 전환) */
  upsertMany(devices: readonly RegisterDeviceInput[], agentId: string, nowIso: string): void;

  findAll(): Device[];

  findById(id: string): Device | null;

  /**
   * 조건에 맞는 미점유 online 기기 1대를 원자적으로 점유
   * @return 점유된 기기 (가용 기기 없으면 null)
   */
  tryOccupy(filter: OccupyFilter, occupantId: string, nowIso: string): Device | null;

  /** 점유 해제 — occupantId 일치 시에만 성공 */
  release(deviceId: string, occupantId: string): ReleaseResult;

  /**
   * 점유 활동 시각 갱신 (sliding TTL 연장) — occupantId 일치 시에만 성공.
   * status 무관: 터널 블립으로 offline인 동안에도 점유는 유지되므로 연장 가능해야 함
   */
  renewOccupation(deviceId: string, occupantId: string, nowIso: string): RenewResult;

  /**
   * 활동이 cutoff 이전인 점유 회수 — 기기 status는 유지 (즉시 재점유 가능)
   * @return 회수된 기기 ID 목록
   */
  expireIdleOccupations(cutoffIso: string): string[];

  /** 하트비트 시각 갱신 */
  heartbeat(deviceIds: readonly string[], agentId: string, nowIso: string): void;

  /** Agent 연결 종료 시 해당 Agent의 기기 전체 오프라인 처리 */
  markAgentOffline(agentId: string): void;

  /**
   * 하트비트가 cutoff 이전인 기기 오프라인 처리
   * @return 오프라인 처리된 기기 ID 목록
   */
  markStaleOffline(cutoffIso: string): string[];
}
