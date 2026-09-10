package com.nebula.mirror

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Args 파싱 계약 — Agent(android-stream.ts)가 보내는 app_process 인자와 1:1 일치.
 * 여기 인자 이름을 바꾸면 반드시 android-stream.ts spawnDaemon도 함께 바꿀 것
 */
class ArgsTest {
    @Test
    fun `Agent가 보내는 전체 인자 파싱`() {
        val args = Args.parse(
            arrayOf(
                "--bitrate", "4000000",
                "--fps", "30",
                "--iframe", "2",
                "--repeat-ms", "200",
                "--swap-poll-ms", "1000",
                "--accept-deadline-ms", "15000",
            ),
        )

        assertEquals(4_000_000, args.tuning.bitRate)
        assertEquals(30, args.tuning.fps)
        assertEquals(2, args.tuning.iframeIntervalSec)
        assertEquals(200L, args.tuning.repeatFrameMs)
        assertEquals(1_000L, args.tuning.swapPollMs)
        assertEquals(15_000L, args.acceptDeadlineMs)
    }

    @Test
    fun `인자 없으면 전부 기본값`() {
        val args = Args.parse(arrayOf())

        assertEquals(EncoderTuning.DEFAULT_BIT_RATE, args.tuning.bitRate)
        assertEquals(EncoderTuning.DEFAULT_FPS, args.tuning.fps)
        assertEquals(EncoderTuning.DEFAULT_SWAP_POLL_MS, args.tuning.swapPollMs)
        assertEquals(Args.DEFAULT_ACCEPT_DEADLINE_MS, args.acceptDeadlineMs)
        assertEquals(Args.DEFAULT_SOCKET, args.socketName)
        assertEquals(Args.DEFAULT_DISPLAY_ID, args.displayId)
    }

    @Test
    fun `probe 플래그`() {
        assertTrue(Args.parse(arrayOf("--probe")).isProbe)
    }

    @Test
    fun `비정수·음수·미지원 인자는 거부`() {
        assertThrows(IllegalArgumentException::class.java) { Args.parse(arrayOf("--fps", "abc")) }
        assertThrows(IllegalArgumentException::class.java) { Args.parse(arrayOf("--bitrate", "-1")) }
        assertThrows(IllegalArgumentException::class.java) { Args.parse(arrayOf("--fps")) }
        assertThrows(IllegalArgumentException::class.java) { Args.parse(arrayOf("--unknown", "x")) }
    }
}
