import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuthErrors, ApiCommandErrors } from '../common/api-errors.decorator';
import { toScreenshotResult, toUiDumpResult } from './command-result.guards';
import { CommandsService } from './commands.service';
import { PressButtonDto, SwipeDto, TapDto, TypeTextDto, UiDumpDto } from './dto/action.dtos';
import {
  AckCommandResponseDto,
  AckResultDto,
  ScreenshotCommandResponseDto,
  UiDumpCommandResponseDto,
} from './dto/command-response.dtos';

/** 스와이프 기본 시간 (ms) */
const DEFAULT_SWIPE_DURATION_MS = 300;

/** 기기 조작 API — 점유자만 호출 가능, Agent 터널로 프록시 */
@ApiTags('commands')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiCommandErrors()
@Controller('devices/:id/actions')
export class CommandsController {
  constructor(private readonly commandsService: CommandsService) {}

  @ApiOperation({ summary: '좌표 탭' })
  @ApiOkResponse({ type: AckCommandResponseDto })
  @Post('tap')
  async tap(@Param('id') deviceId: string, @Body() dto: TapDto): Promise<AckCommandResponseDto> {
    const result = await this.commandsService.execute(deviceId, dto.occupantId, {
      kind: 'tap',
      x: dto.x,
      y: dto.y,
    });
    // ack 계열은 pass-through 유지 — 클라이언트가 파싱하는 필드가 없어 경계 검증 생략
    return { result: result as AckResultDto };
  }

  @ApiOperation({ summary: '스와이프' })
  @ApiOkResponse({ type: AckCommandResponseDto })
  @Post('swipe')
  async swipe(
    @Param('id') deviceId: string,
    @Body() dto: SwipeDto,
  ): Promise<AckCommandResponseDto> {
    const result = await this.commandsService.execute(deviceId, dto.occupantId, {
      kind: 'swipe',
      fromX: dto.fromX,
      fromY: dto.fromY,
      toX: dto.toX,
      toY: dto.toY,
      durationMs: dto.durationMs ?? DEFAULT_SWIPE_DURATION_MS,
    });
    return { result: result as AckResultDto };
  }

  @ApiOperation({ summary: '텍스트 입력' })
  @ApiOkResponse({ type: AckCommandResponseDto })
  @Post('type')
  async type(
    @Param('id') deviceId: string,
    @Body() dto: TypeTextDto,
  ): Promise<AckCommandResponseDto> {
    const result = await this.commandsService.execute(deviceId, dto.occupantId, {
      kind: 'typeText',
      text: dto.text,
    });
    return { result: result as AckResultDto };
  }

  @ApiOperation({ summary: 'UI 트리 덤프' })
  @ApiOkResponse({ type: UiDumpCommandResponseDto })
  @Post('ui-dump')
  async uiDump(
    @Param('id') deviceId: string,
    @Body() dto: UiDumpDto,
  ): Promise<UiDumpCommandResponseDto> {
    const result = await this.commandsService.execute(deviceId, dto.occupantId, {
      kind: 'uiDump',
    });
    return { result: toUiDumpResult(result) };
  }

  @ApiOperation({ summary: '하드웨어 버튼 (home)' })
  @ApiOkResponse({ type: AckCommandResponseDto })
  @Post('press')
  async press(
    @Param('id') deviceId: string,
    @Body() dto: PressButtonDto,
  ): Promise<AckCommandResponseDto> {
    const result = await this.commandsService.execute(deviceId, dto.occupantId, {
      kind: 'pressButton',
      button: dto.button,
    });
    return { result: result as AckResultDto };
  }

  @ApiOperation({ summary: '화면 캡처 (JPEG base64 + pt 크기)' })
  @ApiOkResponse({ type: ScreenshotCommandResponseDto })
  @Post('screenshot')
  async screenshot(
    @Param('id') deviceId: string,
    @Body() dto: UiDumpDto,
  ): Promise<ScreenshotCommandResponseDto> {
    const result = await this.commandsService.execute(deviceId, dto.occupantId, {
      kind: 'screenshot',
    });
    return { result: toScreenshotResult(result) };
  }
}
