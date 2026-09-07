import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import { ConfigService } from '@nestjs/config';
import type { WebSocket } from 'ws';
import { DevicesService } from '../devices/devices.service';
import { StreamsGateway } from './streams.gateway';
import { StreamsRelayService } from './streams-relay.service';

class FakeSocket extends EventEmitter {
  closedWith: { code?: number } | null = null;

  close(code?: number): void {
    this.closedWith = { code };
  }
}

interface Harness {
  gateway: StreamsGateway;
  relay: { addViewer: jest.Mock; removeViewer: jest.Mock };
  devicesService: { getById: jest.Mock };
}

function createGateway(): Harness {
  const config = { get: () => 'client-token-24chars-long!!' } as unknown as ConfigService;
  const relay = { addViewer: jest.fn(), removeViewer: jest.fn() };
  const devicesService = {
    getById: jest.fn().mockReturnValue({ occupantId: 'occupant-1' }),
  };
  return {
    gateway: new StreamsGateway(
      config,
      relay as unknown as StreamsRelayService,
      devicesService as unknown as DevicesService,
    ),
    relay,
    devicesService,
  };
}

function createRequest(query: string): IncomingMessage {
  return { url: `/stream?${query}`, headers: {} } as IncomingMessage;
}

const VALID_QUERY =
  'token=client-token-24chars-long!!&deviceId=udid-1&occupantId=occupant-1';

describe('StreamsGateway', () => {
  test('토큰·점유자 일치 시 시청자 등록', () => {
    const { gateway, relay } = createGateway();
    const socket = new FakeSocket();

    gateway.handleConnection(socket as unknown as WebSocket, createRequest(VALID_QUERY));

    expect(socket.closedWith).toBeNull();
    expect(relay.addViewer).toHaveBeenCalledWith('udid-1', socket);
  });

  test('토큰 불일치는 4401', () => {
    const { gateway, relay } = createGateway();
    const socket = new FakeSocket();

    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('token=wrong&deviceId=udid-1&occupantId=occupant-1'),
    );

    expect(socket.closedWith?.code).toBe(4401);
    expect(relay.addViewer).not.toHaveBeenCalled();
  });

  test('deviceId·occupantId 누락은 4400', () => {
    const { gateway } = createGateway();
    const socket = new FakeSocket();

    gateway.handleConnection(
      socket as unknown as WebSocket,
      createRequest('token=client-token-24chars-long!!&deviceId=udid-1'),
    );

    expect(socket.closedWith?.code).toBe(4400);
  });

  test('점유자 불일치·미등록 기기는 4403 — 화면 관람도 점유자 전용', () => {
    const { gateway, relay, devicesService } = createGateway();
    const wrongOccupant = new FakeSocket();
    gateway.handleConnection(
      wrongOccupant as unknown as WebSocket,
      createRequest('token=client-token-24chars-long!!&deviceId=udid-1&occupantId=other'),
    );
    expect(wrongOccupant.closedWith?.code).toBe(4403);

    devicesService.getById.mockImplementation(() => {
      throw new Error('기기 없음');
    });
    const unknownDevice = new FakeSocket();
    gateway.handleConnection(unknownDevice as unknown as WebSocket, createRequest(VALID_QUERY));
    expect(unknownDevice.closedWith?.code).toBe(4403);
    expect(relay.addViewer).not.toHaveBeenCalled();
  });

  test('disconnect 시 시청자 해제', () => {
    const { gateway, relay } = createGateway();
    const socket = new FakeSocket();
    gateway.handleConnection(socket as unknown as WebSocket, createRequest(VALID_QUERY));

    gateway.handleDisconnect(socket as unknown as WebSocket);

    expect(relay.removeViewer).toHaveBeenCalledWith('udid-1', socket);
  });
});
