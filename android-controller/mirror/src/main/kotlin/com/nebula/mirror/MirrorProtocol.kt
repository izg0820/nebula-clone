package com.nebula.mirror

import java.nio.ByteBuffer

/**
 * 미러링 전송 프로토콜 (자체 정의, big-endian) — Agent TS 파서와 동일 바이트 픽스처로 교차 검증
 *
 * 프리앰블 16B: [u32 magic 'NBLA'][u16 ver=1][u8 codec=1][u8 rsv][u16 w][u16 h][u32 rsv]
 * 패킷 14B 헤더: [u8 flags(bit0 key)][u8 rsv][u16 w][u16 h][u32 ptsMs][u32 len] + Annex-B payload
 *
 * 해상도를 매 패킷에 실음 — 접힘/회전으로 인한 해상도 변경 이벤트·파서 상태 제거.
 * SPS/PPS는 별도 패킷 없이 모든 키프레임 payload 앞에 인밴드 (자립 키프레임)
 */
object MirrorProtocol {
    const val MAGIC: Int = 0x4E424C41 // 'NBLA'
    const val VERSION: Int = 1
    const val CODEC_H264: Int = 1
    const val PREAMBLE_BYTES: Int = 16
    const val PACKET_HEADER_BYTES: Int = 14
    const val FLAG_KEY: Int = 0x01

    fun preamble(width: Int, height: Int): ByteArray {
        require(width in 1..0xFFFF && height in 1..0xFFFF) { "해상도 범위 초과: ${width}x$height" }
        val buffer = ByteBuffer.allocate(PREAMBLE_BYTES)
        buffer.putInt(MAGIC)
        buffer.putShort(VERSION.toShort())
        buffer.put(CODEC_H264.toByte())
        buffer.put(0)
        buffer.putShort(width.toShort())
        buffer.putShort(height.toShort())
        buffer.putInt(0)
        return buffer.array()
    }

    fun packetHeader(isKey: Boolean, width: Int, height: Int, ptsMs: Long, payloadLength: Int): ByteArray {
        require(width in 1..0xFFFF && height in 1..0xFFFF) { "해상도 범위 초과: ${width}x$height" }
        require(payloadLength > 0) { "빈 payload" }
        val buffer = ByteBuffer.allocate(PACKET_HEADER_BYTES)
        val flags = if (isKey) FLAG_KEY else 0
        buffer.put(flags.toByte())
        buffer.put(0)
        buffer.putShort(width.toShort())
        buffer.putShort(height.toShort())
        buffer.putInt((ptsMs and 0xFFFFFFFFL).toInt())
        buffer.putInt(payloadLength)
        return buffer.array()
    }
}
