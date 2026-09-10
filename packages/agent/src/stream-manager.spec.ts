import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentFrame, FRAME_FORMAT_H264 } from '@nebula/shared';
import { H264Stream } from './h264-stream';
import { StreamManager } from './stream-manager';

/** mirror-helper 계약 재현: stderr에 해상도, stdout에 [u32 len][u8 isKey][payload] 반복 */
const HELPER_SCRIPT = `#!/bin/bash
echo "인코더 초기화: 644x1398" >&2
while true; do
  printf '\\x00\\x00\\x00\\x04\\x01\\x00\\x00\\x00\\x01'
  sleep 0.03
done
`;

describe('StreamManager (가짜 mirror-helper 팩토리 연동)', () => {
  let workDir: string;
  let helperPath: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'nebula-helper-'));
    helperPath = join(workDir, 'fake-helper');
    writeFileSync(helperPath, HELPER_SCRIPT);
    chmodSync(helperPath, 0o755);
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function h264Factory(frames: AgentFrame[]): StreamManager {
    return new StreamManager((deviceId) =>
      new H264Stream({ helperPath, deviceName: 'iPhone', deviceId }, (frame) => {
        frames.push(frame);
        return true;
      }),
    );
  }

  test('발견된 기기의 스트림 기동 → H.264 프레임 푸시, stopAll → 중단', async () => {
    const frames: AgentFrame[] = [];
    const manager = h264Factory(frames);

    manager.syncAlwaysOn(['u1']);
    await new Promise((resolve) => setTimeout(resolve, 500));
    manager.stopAll();

    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]).toMatchObject({
      deviceId: 'u1',
      format: FRAME_FORMAT_H264,
      isKey: true,
      width: 644,
      height: 1398,
    });

    // 중지 후 새 프레임 없음 (SIGTERM 전달 중이던 잔여 청크 소량 허용)
    await new Promise((resolve) => setTimeout(resolve, 150));
    const countAfterStop = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(frames.length).toBeLessThanOrEqual(countAfterStop + 2);
  });

  test('팩토리가 null 반환(생성 보류)이면 미기동 — 다음 주기에 재시도 가능', async () => {
    let attempts = 0;
    const manager = new StreamManager(() => {
      attempts += 1;
      return null;
    });

    manager.syncAlwaysOn(['unknown']);
    manager.syncAlwaysOn(['unknown']);
    manager.stopAll();

    expect(attempts).toBe(2);
  });

  test('syncAlwaysOn에서 사라진 기기는 중지됨', async () => {
    const frames: AgentFrame[] = [];
    const manager = h264Factory(frames);

    manager.syncAlwaysOn(['u1']);
    await new Promise((resolve) => setTimeout(resolve, 400));
    manager.syncAlwaysOn([]);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const countAfterRemoval = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(frames.length).toBeLessThanOrEqual(countAfterRemoval + 2);
    manager.stopAll();
  });
});
