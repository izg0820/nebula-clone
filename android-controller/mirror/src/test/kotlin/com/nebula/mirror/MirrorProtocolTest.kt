package com.nebula.mirror

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * 바이트 레이아웃 고정 테스트 — 동일 픽스처를 Agent TS 파서 테스트(mirror-packet-parser.spec.ts)와
 * 공유해 양단 교차 검증. 여기 기대값을 바꾸면 반드시 TS 쪽도 함께 바꿀 것
 */
class MirrorProtocolTest {
    @Test
    fun `프리앰블 16바이트 고정 레이아웃`() {
        val bytes = MirrorProtocol.preamble(1248, 1972)

        val expected = byteArrayOf(
            0x4E, 0x42, 0x4C, 0x41, // 'NBLA'
            0x00, 0x01, // ver=1
            0x01, // codec=h264
            0x00, // rsv
            0x04, 0xE0.toByte(), // w=1248
            0x07, 0xB4.toByte(), // h=1972
            0x00, 0x00, 0x00, 0x00, // rsv
        )
        assertArrayEquals(expected, bytes)
    }

    @Test
    fun `키프레임 패킷 헤더 14바이트 고정 레이아웃`() {
        val bytes = MirrorProtocol.packetHeader(isKey = true, width = 1248, height = 1972, ptsMs = 0x01020304L, payloadLength = 5)

        val expected = byteArrayOf(
            0x01, // flags: key
            0x00, // rsv
            0x04, 0xE0.toByte(), // w=1248
            0x07, 0xB4.toByte(), // h=1972
            0x01, 0x02, 0x03, 0x04, // ptsMs
            0x00, 0x00, 0x00, 0x05, // len=5
        )
        assertArrayEquals(expected, bytes)
    }

    @Test
    fun `일반 프레임은 flags 0`() {
        val bytes = MirrorProtocol.packetHeader(isKey = false, width = 2448, height = 1848, ptsMs = 0L, payloadLength = 1)
        assertEquals(0x00.toByte(), bytes[0])
    }

    @Test
    fun `ptsMs는 u32로 절단`() {
        val bytes = MirrorProtocol.packetHeader(isKey = false, width = 10, height = 10, ptsMs = 0x1_FFFFFFFFL, payloadLength = 1)
        // 상위 비트 절단 → 0xFFFFFFFF
        assertEquals(0xFF.toByte(), bytes[6])
        assertEquals(0xFF.toByte(), bytes[9])
    }

    @Test
    fun `해상도 범위 초과는 거부`() {
        assertThrows(IllegalArgumentException::class.java) { MirrorProtocol.preamble(0, 100) }
        assertThrows(IllegalArgumentException::class.java) { MirrorProtocol.preamble(100, 65_536) }
        assertThrows(IllegalArgumentException::class.java) {
            MirrorProtocol.packetHeader(isKey = false, width = 10, height = 10, ptsMs = 0L, payloadLength = 0)
        }
    }
}
