import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CommandsService } from './commands.service';
import { SwipeDto, TapDto, TypeTextDto, UiDumpDto } from './dto/action.dtos';

/** 스와이프 기본 시간 (ms) */
const DEFAULT_SWIPE_DURATION_MS = 300;

/** 명령 응답 공통 형태 */
interface CommandResponse {
  readonly result: unknown;
}

/** 기기 조작 API — 점유자만 호출 가능, Agent 터널로 프록시 */
@ApiTags('commands')
@ApiBearerAuth()
@Controller('devices/:id/actions')
export class CommandsController {
  constructor(private readonly commandsService: CommandsService) {}

  @ApiOperation({ summary: '좌표 탭' })
  @Post('tap')
  async tap(@Param('id') deviceId: string, @Body() dto: TapDto): Promise<CommandResponse> {
    const result = await this.commandsService.execute(deviceId, dto.occupantId, {
      kind: 'tap',
      x: dto.x,
      y: dto.y,
    });
    return { result };
  }

  @ApiOperation({ summary: '스와이프' })
  @Post('swipe')
  async swipe(@Param('id') deviceId: string, @Body() dto: SwipeDto): Promise<CommandResponse> {
    const result = await this.commandsService.execute(deviceId, dto.occupantId, {
      kind: 'swipe',
      fromX: dto.fromX,
      fromY: dto.fromY,
      toX: dto.toX,
      toY: dto.toY,
      durationMs: dto.durationMs ?? DEFAULT_SWIPE_DURATION_MS,
    });
    return { result };
  }

  @ApiOperation({ summary: '텍스트 입력' })
  @Post('type')
  async type(@Param('id') deviceId: string, @Body() dto: TypeTextDto): Promise<CommandResponse> {
    const result = await this.commandsService.execute(deviceId, dto.occupantId, {
      kind: 'typeText',
      text: dto.text,
    });
    return { result };
  }

  @ApiOperation({ summary: 'UI 트리 덤프' })
  @Post('ui-dump')
  async uiDump(@Param('id') deviceId: string, @Body() dto: UiDumpDto): Promise<CommandResponse> {
    const result = await this.commandsService.execute(deviceId, dto.occupantId, {
      kind: 'uiDump',
    });
    return { result };
  }

  @ApiOperation({ summary: '화면 캡처 (JPEG base64 + pt 크기)' })
  @Post('screenshot')
  async screenshot(
    @Param('id') deviceId: string,
    @Body() dto: UiDumpDto,
  ): Promise<CommandResponse> {
    const result = await this.commandsService.execute(deviceId, dto.occupantId, {
      kind: 'screenshot',
    });
    return { result };
  }
}
