import { execFile } from 'child_process';
import { logger } from './logger';

/** adb 호출 기본 대기 상한 — Controller HTTP 타임아웃과 동급 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** exec-out 최대 출력 — screencap PNG 여유 */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * adb 호출 단일 창구 — 항상 execFile 고정 인자 배열 (셸 경유 금지: serial이 명령줄에 들어감).
 * adb 서버 데몬은 공유 자원 — kill-server를 절대 호출하지 않는다
 */
export class AdbClient {
  constructor(private readonly adbPath: string) {}

  /** adb devices -l 원문 (파싱은 android-discovery) */
  listDevices(): Promise<string> {
    return this.run(['devices', '-l']).then((output) => output.toString('utf8'));
  }

  /** adb -s <serial> shell getprop <key> */
  async getProp(serial: string, key: string): Promise<string> {
    const output = await this.run(['-s', serial, 'shell', 'getprop', key]);
    return output.toString('utf8').trim();
  }

  /** 임의 adb 명령 (forward/push/install 등) — 바이너리 출력 대응 */
  run(args: readonly string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(
        this.adbPath,
        [...args],
        { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'buffer' },
        (error, stdout) => {
          if (error) {
            logger.warn({ err: error, args }, 'adb 명령 실패');
            reject(error);
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}
