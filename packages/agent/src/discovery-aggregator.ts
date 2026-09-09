import { DevicePlatform, RegisterDeviceInput } from '@nebula/shared';
import { mergeWithStatic } from './device-discovery';
import { DiscoverySource } from './discovery-source';
import { DiscoveryState } from './discovery-state';

/**
 * 다중 발견 소스 합성 — 소스마다 DiscoveryState를 하나씩 둔다.
 * 실패 카운팅(직전 목록 유지)이 소스 단위라, 한쪽 성공이 다른 쪽 실패 카운터를
 * 리셋하거나 다른 플랫폼 기기를 지우는 일이 없다 (부분 실패 격리)
 */
export class DiscoveryAggregator {
  private readonly states = new Map<DiscoverySource, DiscoveryState>();

  constructor(
    private readonly sources: readonly DiscoverySource[],
    private readonly staticDevices: readonly RegisterDeviceInput[],
  ) {
    for (const source of sources) this.states.set(source, new DiscoveryState());
  }

  /**
   * 전 소스 병렬 발견 (한 소스의 타임아웃이 다른 소스 등록을 막지 않게)
   * @return 서버에 register를 보내야 하면 true
   */
  async refresh(): Promise<boolean> {
    const results = await Promise.all(
      this.sources.map((source) => source.discover().catch(() => null)),
    );
    let shouldRegister = this.staticDevices.length > 0;
    results.forEach((result, index) => {
      const state = this.states.get(this.sources[index]);
      if (state?.apply(result)) shouldRegister = true;
    });
    return shouldRegister;
  }

  /** 발견 결과 + 정적 기기 병합 (정적 우선 dedupe — 기존 mergeWithStatic 재사용) */
  get devices(): readonly RegisterDeviceInput[] {
    const union: RegisterDeviceInput[] = [];
    for (const state of this.states.values()) union.push(...state.current);
    return mergeWithStatic(union, this.staticDevices) ?? [];
  }

  /** 특정 플랫폼의 실기기 id (정적 기기 제외) — 수퍼바이저·스트림 입력 */
  discoveredIds(platform: DevicePlatform): readonly string[] {
    const staticIds = new Set(this.staticDevices.map((device) => device.id));
    const ids: string[] = [];
    for (const [source, state] of this.states) {
      if (source.platform !== platform) continue;
      for (const device of state.current) {
        if (!staticIds.has(device.id)) ids.push(device.id);
      }
    }
    return ids;
  }
}
