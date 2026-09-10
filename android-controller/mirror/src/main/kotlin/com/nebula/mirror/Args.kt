package com.nebula.mirror

/** 데몬 인자 — Agent(android-stream.ts)의 app_process 명령과 계약 일치 */
class Args(
    val isProbe: Boolean,
    val socketName: String,
    val displayId: Int,
    val tuning: EncoderTuning,
    val acceptDeadlineMs: Long,
) {
    companion object {
        const val DEFAULT_SOCKET = "nebula-mirror"
        const val DEFAULT_DISPLAY_ID = 0
        const val DEFAULT_ACCEPT_DEADLINE_MS = 30_000L

        fun parse(argv: Array<String>): Args {
            var isProbe = false
            var socketName = DEFAULT_SOCKET
            var displayId = DEFAULT_DISPLAY_ID
            var acceptDeadlineMs = DEFAULT_ACCEPT_DEADLINE_MS
            var bitRate = EncoderTuning.DEFAULT_BIT_RATE
            var fps = EncoderTuning.DEFAULT_FPS
            var iframeIntervalSec = EncoderTuning.DEFAULT_IFRAME_INTERVAL_SEC
            var repeatFrameMs = EncoderTuning.DEFAULT_REPEAT_FRAME_MS
            var swapPollMs = EncoderTuning.DEFAULT_SWAP_POLL_MS

            var index = 0
            while (index < argv.size) {
                val arg = argv[index]
                if (arg == "--probe") {
                    isProbe = true
                    index += 1
                    continue
                }
                when (arg) {
                    "--socket" -> socketName = requireValue(argv, index)
                    "--display" -> displayId = requireInt(argv, index)
                    "--bitrate" -> bitRate = requireInt(argv, index)
                    "--fps" -> fps = requireInt(argv, index)
                    "--iframe" -> iframeIntervalSec = requireInt(argv, index)
                    "--repeat-ms" -> repeatFrameMs = requireInt(argv, index).toLong()
                    "--swap-poll-ms" -> swapPollMs = requireInt(argv, index).toLong()
                    "--accept-deadline-ms" -> acceptDeadlineMs = requireInt(argv, index).toLong()
                    else -> throw IllegalArgumentException("알 수 없는 인자: $arg")
                }
                index += 2
            }
            val tuning = EncoderTuning(bitRate, fps, iframeIntervalSec, repeatFrameMs, swapPollMs)
            return Args(isProbe, socketName, displayId, tuning, acceptDeadlineMs)
        }

        private fun requireValue(argv: Array<String>, index: Int): String {
            if (index + 1 >= argv.size) throw IllegalArgumentException("${argv[index]} 값 누락")
            return argv[index + 1]
        }

        private fun requireInt(argv: Array<String>, index: Int): Int {
            val value = requireValue(argv, index).toIntOrNull()
                ?: throw IllegalArgumentException("${argv[index]} 값이 정수가 아님")
            require(value > 0) { "${argv[index]} 값은 양수여야 함" }
            return value
        }
    }
}

/** 인코더 튜닝 — 전부 Agent env에서 전달 (미지정 시 기본값) */
class EncoderTuning(
    val bitRate: Int,
    val fps: Int,
    val iframeIntervalSec: Int,
    val repeatFrameMs: Long,
    val swapPollMs: Long,
) {
    companion object {
        const val DEFAULT_BIT_RATE = 8_000_000
        const val DEFAULT_FPS = 60
        const val DEFAULT_IFRAME_INTERVAL_SEC = 1
        const val DEFAULT_REPEAT_FRAME_MS = 100L
        const val DEFAULT_SWAP_POLL_MS = 500L
    }
}
