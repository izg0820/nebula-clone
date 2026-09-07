import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PublicDevice, toPublicDevice } from './device.types';
import { DevicesService } from './devices.service';
import { OccupyDeviceDto } from './dto/occupy-device.dto';
import { ReleaseDeviceDto } from './dto/release-device.dto';

/** 점유 응답 — occupantId는 점유자 본인에게만 발급 */
export interface OccupyResponse {
  readonly occupantId: string;
  readonly device: PublicDevice;
}

/** 디바이스 레지스트리·점유 API — 응답에서 occupantId 제외 (점유 응답의 본인 발급분 제외) */
@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @ApiOperation({ summary: '전체 기기 목록 조회' })
  @Get()
  list(): PublicDevice[] {
    return this.devicesService.listAll().map(toPublicDevice);
  }

  @ApiOperation({ summary: '조건에 맞는 기기 1대 점유' })
  @Post('occupy')
  occupy(@Body() dto: OccupyDeviceDto): OccupyResponse {
    const result = this.devicesService.occupy({
      platform: dto.platform,
      tags: dto.tags,
      deviceId: dto.deviceId,
    });
    return { occupantId: result.occupantId, device: toPublicDevice(result.device) };
  }

  @ApiOperation({ summary: '기기 상세 조회' })
  @Get(':id')
  getById(@Param('id') id: string): PublicDevice {
    return toPublicDevice(this.devicesService.getById(id));
  }

  @ApiOperation({ summary: '기기 점유 해제' })
  @Post(':id/release')
  release(@Param('id') id: string, @Body() dto: ReleaseDeviceDto): PublicDevice {
    return toPublicDevice(this.devicesService.release(id, dto.occupantId));
  }
}
