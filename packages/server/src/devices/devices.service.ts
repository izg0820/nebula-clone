import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { HEARTBEAT_TIMEOUT_MS } from '../config/constants';
import { Device, OccupyFilter, RegisterDeviceInput, ReleaseResult } from './device.types';
import { DEVICES_REPOSITORY, DevicesRepository } from './devices.repository';

/** 점유 성공 결과 */
export interface OccupyResult {
  readonly occupantId: string;
  readonly device: Device;
}

/** 해제 실패 결과 → HTTP 예외 매핑 */
const RELEASE_ERRORS: Record<Exclude<ReleaseResult, 'released'>, () => Error> = {
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
  constructor(
    @Inject(DEVICES_REPOSITORY) private readonly repository: DevicesRepository,
  ) {}

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
    if (result !== 'released') throw RELEASE_ERRORS[result]();
    return this.getById(deviceId);
  }

  /** Agent 기기 등록 (online 전환) */
  registerFromAgent(devices: readonly RegisterDeviceInput[], agentId: string): void {
    this.repository.upsertMany(devices, agentId, new Date().toISOString());
  }

  /** Agent 하트비트 반영 */
  recordHeartbeat(deviceIds: readonly string[], agentId: string): void {
    this.repository.heartbeat(deviceIds, agentId, new Date().toISOString());
  }

  /** Agent 연결 종료 — 소속 기기 오프라인 + 점유 해제 */
  handleAgentDisconnect(agentId: string): void {
    this.repository.markAgentOffline(agentId);
  }

  /** 하트비트 만료 기기 오프라인 처리 — 처리된 기기 ID 반환 */
  expireStaleDevices(): string[] {
    const cutoffIso = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
    return this.repository.markStaleOffline(cutoffIso);
  }
}
