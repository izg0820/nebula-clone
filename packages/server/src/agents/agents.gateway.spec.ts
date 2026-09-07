import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'http';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { encodeAgentFrame } from '@nebula/shared';
import { DevicesService } from '../devices/devices.service';
import { StreamsRelayService } from '../streams/streams-relay.service';
import { AgentNotConnectedError, AgentsGateway } from './agents.gateway';

/** close·send 호출을 기록하는 목 소켓 */
class FakeSocket extends EventEmitter {
  agentId?: string;
  closedWith: { code?: number; reason?: string } | null = null;
  sentPayloads: string[] = [];
  readonly OPEN = 1;
  readyState = 1;

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

interface DevicesServiceMock {
  registerFromAgent: jest.Mock;
  recordHeartbeat: jest.Mock;
  handleAgentDisconnect: jest.Mock;
  getById: jest.Mock;
}

interface RelayMock {
  broadcast: jest.Mock;
}

function createGateway(): {
  gateway: AgentsGateway;
  service: DevicesServiceMock;
  relay: RelayMock;
} {
  const config = { get: () => 'agent-token' } as unknown as ConfigService;
  const service: DevicesServiceMock = {
    registerFromAgent: jest.fn(),
    recordHeartbeat: jest.fn(),
    handleAgentDisconnect: jest.fn(),
    getById: jest.fn().mockReturnValue({ agentId: 'agent-1' }),
  };
  const relay: RelayMock = {
    broadcast: jest.fn(),
  };
  return {
    gateway: new AgentsGateway(
      config,
      service as unknown as DevicesService,
      relay as unknown as StreamsRelayService,
    ),
    service,
    relay,
  };
}

function createRequest(url: string): IncomingMessage {
  return { url, headers: {} } as IncomingMessage;
}

describe('AgentsGateway', () => {
  test('잘못된 토큰이면 4401로 연결 종료', () => {
    const { gateway } = createGateway();
    const socket = new FakeSocket();

    gateway.handleConnection(socket as unknown as WebSocket, createRequest('/agent?token=wrong'));

    expect(socket.closedWith?.code).toBe(4401);
  });

  test('register 메시지로 기기 등록', () => {
    const { gateway, service } = createGateway();
    const socket = new FakeSocket();
    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=agent-1'),
    );

    socket.emit(
      'message',
      JSON.stringify({
        type: 'register',
        devices: [
          { id: 'udid-1', name: 'iPhone', platform: 'ios', osVersion: '17.5', tags: [] },
        ],
      }),
    );

    expect(service.registerFromAgent).toHaveBeenCalledWith(
      [{ id: 'udid-1', name: 'iPhone', platform: 'ios', osVersion: '17.5', tags: [] }],
      'agent-1',
    );
  });

  test('heartbeat 메시지로 하트비트 갱신, 잘못된 메시지는 무시', () => {
    const { gateway, service } = createGateway();
    const socket = new FakeSocket();
    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=agent-1'),
    );

    socket.emit('message', JSON.stringify({ type: 'heartbeat', deviceIds: ['udid-1'] }));
    socket.emit('message', 'not-json');

    expect(service.recordHeartbeat).toHaveBeenCalledWith(['udid-1'], 'agent-1');
    expect(service.recordHeartbeat).toHaveBeenCalledTimes(1);
  });

  test('연결 종료 시 해당 Agent 기기 오프라인 처리', () => {
    const { gateway, service } = createGateway();
    const socket = new FakeSocket();
    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=agent-1'),
    );

    gateway.handleDisconnect(socket as unknown as WebSocket);

    expect(service.handleAgentDisconnect).toHaveBeenCalledWith('agent-1');
  });

  test('동일 agentId 재연결 시 기존 소켓의 늦은 disconnect가 새 연결을 무너뜨리지 않음', () => {
    const { gateway, service } = createGateway();
    const oldSocket = new FakeSocket();
    const newSocket = new FakeSocket();
    const request = createRequest('/agent?token=agent-token&agentId=agent-1');

    gateway.handleConnection(oldSocket as unknown as WebSocket, request);
    gateway.handleConnection(newSocket as unknown as WebSocket, request);

    // 기존 소켓은 4409로 종료 요청됨
    expect(oldSocket.closedWith?.code).toBe(4409);

    // 옛 소켓의 늦은 close — 현행(newSocket)이 아니므로 오프라인 처리 금지
    gateway.handleDisconnect(oldSocket as unknown as WebSocket);
    expect(service.handleAgentDisconnect).not.toHaveBeenCalled();

    // 현행 소켓 close는 정상 오프라인 처리
    gateway.handleDisconnect(newSocket as unknown as WebSocket);
    expect(service.handleAgentDisconnect).toHaveBeenCalledWith('agent-1');
  });

  test('허용 형식 밖의 agentId면 4400으로 연결 종료', () => {
    const { gateway } = createGateway();
    const socket = new FakeSocket();

    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=한글%20공백!'),
    );

    expect(socket.closedWith?.code).toBe(4400);
  });

  test('저장소 예외가 소켓 처리 중 프로세스를 죽이지 않음', () => {
    const { gateway, service } = createGateway();
    service.registerFromAgent.mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    const socket = new FakeSocket();
    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=agent-1'),
    );

    expect(() =>
      socket.emit(
        'message',
        JSON.stringify({
          type: 'register',
          devices: [{ id: 'u1', name: 'n', platform: 'ios', osVersion: '17', tags: [] }],
        }),
      ),
    ).not.toThrow();
  });

  test('sendCommand는 터널로 명령 전송 후 commandResult로 resolve', async () => {
    const { gateway } = createGateway();
    const socket = new FakeSocket();
    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=agent-1'),
    );

    const pending = gateway.sendCommand('agent-1', 'udid-1', { kind: 'tap', x: 1, y: 2 });

    // 전송된 command 메시지 확인 후 Agent 응답 시뮬레이션
    const sent = JSON.parse(socket.sentPayloads[0]);
    expect(sent).toMatchObject({
      type: 'command',
      deviceId: 'udid-1',
      action: { kind: 'tap', x: 1, y: 2 },
    });
    socket.emit(
      'message',
      JSON.stringify({
        type: 'commandResult',
        requestId: sent.requestId,
        outcome: { ok: true, result: 'done' },
      }),
    );

    await expect(pending).resolves.toEqual({ ok: true, result: 'done' });
  });

  test('sendCommand는 응답 없으면 타임아웃 실패로 resolve', async () => {
    jest.useFakeTimers();
    try {
      const { gateway } = createGateway();
      const socket = new FakeSocket();
      gateway.handleConnection(
        socket as unknown as WebSocket,
        createRequest('/agent?token=agent-token&agentId=agent-1'),
      );

      const pending = gateway.sendCommand('agent-1', 'udid-1', { kind: 'uiDump' });
      jest.advanceTimersByTime(20_000);

      await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('Agent 연결 종료 시 in-flight 명령이 즉시 agent_disconnected로 실패', async () => {
    const { gateway } = createGateway();
    const socket = new FakeSocket();
    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=agent-1'),
    );

    const pending = gateway.sendCommand('agent-1', 'udid-1', { kind: 'uiDump' });
    gateway.handleDisconnect(socket as unknown as WebSocket);

    await expect(pending).resolves.toEqual({ ok: false, error: 'agent_disconnected' });
  });

  test('다른 Agent가 보낸 commandResult는 매칭하지 않음', async () => {
    jest.useFakeTimers();
    try {
      const { gateway } = createGateway();
      const target = new FakeSocket();
      const intruder = new FakeSocket();
      gateway.handleConnection(
        target as unknown as WebSocket,
        createRequest('/agent?token=agent-token&agentId=agent-1'),
      );
      gateway.handleConnection(
        intruder as unknown as WebSocket,
        createRequest('/agent?token=agent-token&agentId=agent-2'),
      );

      const pending = gateway.sendCommand('agent-1', 'udid-1', { kind: 'uiDump' });
      const sent = JSON.parse(target.sentPayloads[0]);

      // 다른 Agent가 requestId를 가로채 응답 — 무시돼야 함
      intruder.emit(
        'message',
        JSON.stringify({
          type: 'commandResult',
          requestId: sent.requestId,
          outcome: { ok: true, result: 'hijacked' },
        }),
      );
      jest.advanceTimersByTime(20_000);

      await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('스펙 미교환(구버전) Agent에 pressButton은 전송 없이 즉시 거부', async () => {
    const { gateway } = createGateway();
    const socket = new FakeSocket();
    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=agent-1'),
    );
    // 스펙(capabilities) 없는 구버전 register
    socket.emit(
      'message',
      JSON.stringify({
        type: 'register',
        devices: [{ id: 'u1', name: 'n', platform: 'ios', osVersion: '17', tags: [] }],
      }),
    );

    const outcome = await gateway.sendCommand('agent-1', 'u1', {
      kind: 'pressButton',
      button: 'home',
    });

    expect(outcome).toEqual({ ok: false, error: 'unsupported_action' });
    // command 메시지가 터널로 나가지 않았어야 함 (타임아웃 방지가 목적)
    const commandMessages = socket.sentPayloads
      .map((payload) => JSON.parse(payload))
      .filter((message) => message.type === 'command');
    expect(commandMessages).toHaveLength(0);
  });

  test('스펙 교환한 Agent에는 pressButton 전송', () => {
    const { gateway } = createGateway();
    const socket = new FakeSocket();
    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=agent-1'),
    );
    socket.emit(
      'message',
      JSON.stringify({
        type: 'register',
        devices: [{ id: 'u1', name: 'n', platform: 'ios', osVersion: '17', tags: [] }],
        capabilities: ['tap', 'pressButton'],
      }),
    );

    void gateway.sendCommand('agent-1', 'u1', { kind: 'pressButton', button: 'home' });

    const commandMessages = socket.sentPayloads
      .map((payload) => JSON.parse(payload))
      .filter((message) => message.type === 'command');
    expect(commandMessages).toHaveLength(1);
  });

  test('sendCommand는 터널 미연결이면 즉시 거부', async () => {
    const { gateway } = createGateway();

    await expect(gateway.sendCommand('없는-agent', 'udid-1', { kind: 'uiDump' })).rejects.toThrow(
      AgentNotConnectedError,
    );
  });

  test('바이너리 프레임은 릴레이로 브로드캐스트', () => {
    const { gateway, relay } = createGateway();
    const socket = new FakeSocket();
    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=agent-1'),
    );

    const frame = encodeAgentFrame({
      deviceId: 'udid-1',
      format: 2,
      isKey: true,
      width: 430,
      height: 932,
      stampMs: 1000,
      payload: new Uint8Array([0xff, 0xd8]),
    });
    socket.emit('message', Buffer.from(frame), true);

    expect(relay.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'udid-1', width: 430, height: 932 }),
    );
  });

  test('대체된(superseded) 옛 소켓의 메시지는 무시 — 레지스트리·명령 상태 변조 방지', () => {
    const { gateway, service } = createGateway();
    const oldSocket = new FakeSocket();
    gateway.handleConnection(
      oldSocket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=agent-1'),
    );
    const newSocket = new FakeSocket();
    gateway.handleConnection(
      newSocket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=agent-1'),
    );
    expect(oldSocket.closedWith?.code).toBe(4409);

    // 옛 소켓이 close를 무시하고 계속 보내는 heartbeat — 무시돼야 함
    oldSocket.emit('message', JSON.stringify({ type: 'heartbeat', deviceIds: ['udid-1'] }), false);
    expect(service.recordHeartbeat).not.toHaveBeenCalled();

    // 현행 소켓의 heartbeat은 정상 처리
    newSocket.emit('message', JSON.stringify({ type: 'heartbeat', deviceIds: ['udid-1'] }), false);
    expect(service.recordHeartbeat).toHaveBeenCalledWith(['udid-1'], 'agent-1');
  });

  test('소유하지 않은 기기의 프레임은 릴레이하지 않음 (화면 위조 방지)', () => {
    const { gateway, relay, service } = createGateway();
    service.getById.mockReturnValue({ agentId: '다른-agent' });
    const socket = new FakeSocket();
    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('/agent?token=agent-token&agentId=agent-1'),
    );

    const frame = encodeAgentFrame({
      deviceId: 'udid-1',
      format: 2,
      isKey: true,
      width: 430,
      height: 932,
      stampMs: 0,
      payload: new Uint8Array([0x01]),
    });
    socket.emit('message', Buffer.from(frame), true);

    expect(relay.broadcast).not.toHaveBeenCalled();
  });

  test('인증 실패한 소켓의 disconnect는 아무것도 하지 않음', () => {
    const { gateway, service } = createGateway();
    const socket = new FakeSocket();
    gateway.handleConnection(socket as unknown as WebSocket, createRequest('/agent?token=wrong'));

    gateway.handleDisconnect(socket as unknown as WebSocket);

    expect(service.handleAgentDisconnect).not.toHaveBeenCalled();
  });
});
