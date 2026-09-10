package com.nebula.mirror

/** 데몬 인자 — Agent(android-stream.ts)의 app_process 명령과 계약 일치 */
class Args(
    val isProbe: Boolean,
    val socketName: String,
    val displayId: Int,
) {
    companion object {
        const val DEFAULT_SOCKET = "nebula-mirror"
        const val DEFAULT_DISPLAY_ID = 0

        fun parse(argv: Array<String>): Args {
            var isProbe = false
            var socketName = DEFAULT_SOCKET
            var displayId = DEFAULT_DISPLAY_ID

            var index = 0
            while (index < argv.size) {
                val arg = argv[index]
                if (arg == "--probe") {
                    isProbe = true
                    index += 1
                    continue
                }
                if (arg == "--socket") {
                    socketName = requireValue(argv, index)
                    index += 2
                    continue
                }
                if (arg == "--display") {
                    displayId = requireValue(argv, index).toIntOrNull()
                        ?: throw IllegalArgumentException("--display 값이 정수가 아님")
                    index += 2
                    continue
                }
                throw IllegalArgumentException("알 수 없는 인자: $arg")
            }
            return Args(isProbe, socketName, displayId)
        }

        private fun requireValue(argv: Array<String>, index: Int): String {
            if (index + 1 >= argv.size) throw IllegalArgumentException("${argv[index]} 값 누락")
            return argv[index + 1]
        }
    }
}
