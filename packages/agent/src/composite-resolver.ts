import { ControllerEndpointResolver } from './controller-registry';

/** 여러 resolver 합성 — 기기를 소유한 첫 resolver가 담당 (iOS·Android·정적 포트) */
export class CompositeResolver implements ControllerEndpointResolver {
  constructor(private readonly resolvers: readonly ControllerEndpointResolver[]) {}

  resolve(deviceId: string): string | null {
    for (const resolver of this.resolvers) {
      const baseUrl = resolver.resolve(deviceId);
      if (baseUrl) return baseUrl;
    }
    return null;
  }

  isReady(deviceId: string): boolean {
    return this.resolvers.some(
      (resolver) => resolver.resolve(deviceId) !== null && resolver.isReady(deviceId),
    );
  }
}
