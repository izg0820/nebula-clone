import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { HEARTBEAT_TIMEOUT_MS, OCCUPATION_TTL_MS, resolveMsEnv } from '../config/constants';
import { Device, OccupationFailure, OccupyFilter, RegisterDeviceInput } from './device.types';
import { DEVICES_REPOSITORY, DevicesRepository } from './devices.repository';

/** 점유 성공 결과 */
export interface OccupyResult {
  readonly occupantId: string;
  readonly device: Device;
}

/** 점유 조작 실패 → HTTP 예외 매핑 (해제·연장 공용) */
const OCCUPATION_ERRORS: Record<OccupationFailure, () => Error> = {
  not_found: () => new NotFoundException('기기 없음'),
  not_occupied: () => new ConflictException('점유 상태 아님'),
  forbidden: () => new ForbiddenException('점유자 불일치'),
};


/**
 * 디바이스 도메인 로직 — Repository 접근은 이 Service로만 일원화
 * (다른 모듈은 이 Service를 경유, Repository 직접 주입 금지)
 */
@Injectable()
export class DevicesService {
  private readonly occupationTtlMs: number;
  private readonly heartbeatTimeoutMs: number;

  constructor(
    @Inject(DEVICES_REPOSITORY) private readonly repository: DevicesRepository,
    config: ConfigService,
  ) {
    this.occupationTtlMs = resolveMsEnv(
      config.get<string>('NEBULA_OCCUPATION_TTL_MS'),
      OCCUPATION_TTL_MS,
    );
    this.heartbeatTimeoutMs = resolveMsEnv(
      config.get<string>('NEBULA_HEARTBEAT_TIMEOUT_MS'),
      HEARTBEAT_TIMEOUT_MS,
    );
  }

  listAll(): Device[] {
    return this.repository.findAll();
  }

  getById(id: string): Device {
    const device = this.repository.findById(id);
    if (!device) throw new NotFoundException(`기기 없음: ${id}`);
    return device;
  }

  /** 조건에 맞는 기기 1대 점유 — 가용 기기 없으면 409 */
  occupy(filter: OccupyFilter): OccupyResult {
    const occupantId = randomUUID();
    const device = this.repository.tryOccupy(filter, occupantId, new Date().toISOString());
    if (!device) throw new ConflictException('가용 기기 없음');
    return { occupantId, device };
  }

  /** 점유 해제 — occupantId 불일치 시 403 */
  release(deviceId: string, occupantId: string): Device {
    const result = this.repository.release(deviceId, occupantId);
    if (result !== 'released') throw OCCUPATION_ERRORS[result]();
    return this.getById(deviceId);
  }

  /** 점유 활동 연장 (sliding TTL) — 불일치 403 / 미점유 409 / 없음 404 */
  renewOccupation(deviceId: string, occupantId: string): Device {
    const result = this.repository.renewOccupation(
      deviceId,
      occupantId,
      new Date().toISOString(),
    );
    if (result !== 'renewed') throw OCCUPATION_ERRORS[result]();
    return this.getById(deviceId);
  }

  /** 활동 없는 점유 회수 — 회수된 기기 ID 반환 (기기 status는 유지) */
  expireIdleOccupations(): string[] {
    const cutoffIso = new Date(Date.now() - this.occupationTtlMs).toISOString();
    return this.repository.expireIdleOccupations(cutoffIso);
  }

  /** 점유 만료 예정 시각 — 클라이언트가 keepalive 주기를 서버 기준으로 잡게 노출 */
  occupationExpiresAt(device: Device): string | null {
    if (!device.lastActivityAt) return null;
    return new Date(new Date(device.lastActivityAt).getTime() + this.occupationTtlMs).toISOString();
  }

  /** Agent 기기 등록 (online 전환) */
  registerFromAgent(devices: readonly RegisterDeviceInput[], agentId: string): void {
    this.repository.upsertMany(devices, agentId, new Date().toISOString());
  }

  /** Agent 하트비트 반영 */
  recordHeartbeat(deviceIds: readonly string[], agentId: string): void {
    this.repository.heartbeat(deviceIds, agentId, new Date().toISOString());
  }

  /** Agent 연결 종료 — 소속 기기 오프라인 (점유는 하트비트 만료까지 유예) */
  handleAgentDisconnect(agentId: string): void {
    this.repository.markAgentOffline(agentId);
  }

  /** 하트비트 만료 기기 오프라인 처리 — 처리된 기기 ID 반환 */
  expireStaleDevices(): string[] {
    const cutoffIso = new Date(Date.now() - this.heartbeatTimeoutMs).toISOString();
    return this.repository.markStaleOffline(cutoffIso);
  }
}
