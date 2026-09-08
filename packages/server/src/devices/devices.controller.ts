import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuthErrors, ApiDeviceErrors } from '../common/api-errors.decorator';
import { toPublicDevice } from './device.types';
import { DevicesService } from './devices.service';
import { KeepaliveDeviceDto } from './dto/keepalive-device.dto';
import { OccupyDeviceDto } from './dto/occupy-device.dto';
import { KeepaliveResponseDto, OccupyResponseDto } from './dto/occupy-response.dto';
import { PublicDeviceDto } from './dto/public-device.dto';
import { ReleaseDeviceDto } from './dto/release-device.dto';

/** 디바이스 레지스트리·점유 API — 응답에서 occupantId 제외 (점유 응답의 본인 발급분 제외) */
@ApiTags('devices')
@ApiBearerAuth()
@ApiAuthErrors()
@Controller('devices')
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @ApiOperation({ summary: '전체 기기 목록 조회' })
  @ApiOkResponse({ type: [PublicDeviceDto] })
  @Get()
  list(): PublicDeviceDto[] {
    return this.devicesService.listAll().map(toPublicDevice);
  }

  @ApiOperation({ summary: '조건에 맞는 기기 1대 점유' })
  @ApiOkResponse({ type: OccupyResponseDto })
  @ApiDeviceErrors()
  @Post('occupy')
  occupy(@Body() dto: OccupyDeviceDto): OccupyResponseDto {
    const result = this.devicesService.occupy({
      platform: dto.platform,
      tags: dto.tags,
      deviceId: dto.deviceId,
    });
    return {
      occupantId: result.occupantId,
      device: toPublicDevice(result.device),
      expiresAt: this.devicesService.occupationExpiresAt(result.device),
    };
  }

  @ApiOperation({ summary: '점유 활동 연장 (sliding TTL keepalive)' })
  @ApiOkResponse({ type: KeepaliveResponseDto })
  @ApiDeviceErrors()
  @Post(':id/keepalive')
  keepalive(@Param('id') id: string, @Body() dto: KeepaliveDeviceDto): KeepaliveResponseDto {
    const device = this.devicesService.renewOccupation(id, dto.occupantId);
    return {
      device: toPublicDevice(device),
      expiresAt: this.devicesService.occupationExpiresAt(device),
    };
  }

  @ApiOperation({ summary: '기기 상세 조회' })
  @ApiOkResponse({ type: PublicDeviceDto })
  @ApiDeviceErrors()
  @Get(':id')
  getById(@Param('id') id: string): PublicDeviceDto {
    return toPublicDevice(this.devicesService.getById(id));
  }

  @ApiOperation({ summary: '기기 점유 해제' })
  @ApiOkResponse({ type: PublicDeviceDto })
  @ApiDeviceErrors()
  @Post(':id/release')
  release(@Param('id') id: string, @Body() dto: ReleaseDeviceDto): PublicDeviceDto {
    return toPublicDevice(this.devicesService.release(id, dto.occupantId));
  }
}
