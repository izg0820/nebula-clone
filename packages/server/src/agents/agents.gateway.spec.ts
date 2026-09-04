import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'http';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { DevicesService } from '../devices/devices.service';
import { AgentsGateway } from './agents.gateway';

/** close 호출을 기록하는 목 소켓 */
class FakeSocket extends EventEmitter {
  agentId?: string;
  closedWith: { code?: number; reason?: string } | null = null;

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }
}

interface DevicesServiceMock {
  registerFromAgent: jest.Mock;
  recordHeartbeat: jest.Mock;
  handleAgentDisconnect: jest.Mock;
}

function createGateway(): { gateway: AgentsGateway; service: DevicesServiceMock } {
  const config = { get: () => 'agent-token' } as unknown as ConfigService;
  const service: DevicesServiceMock = {
    registerFromAgent: jest.fn(),
    recordHeartbeat: jest.fn(),
    handleAgentDisconnect: jest.fn(),
  };
  return { gateway: new AgentsGateway(config, service as unknown as DevicesService), service };
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

  test('인증 실패한 소켓의 disconnect는 아무것도 하지 않음', () => {
    const { gateway, service } = createGateway();
    const socket = new FakeSocket();
    gateway.handleConnection(socket as unknown as WebSocket, createRequest('/agent?token=wrong'));

    gateway.handleDisconnect(socket as unknown as WebSocket);

    expect(service.handleAgentDisconnect).not.toHaveBeenCalled();
  });
});
