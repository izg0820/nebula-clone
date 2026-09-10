package com.nebula.mirror

import android.net.LocalServerSocket
import android.net.LocalSocket
import java.io.BufferedOutputStream
import java.io.OutputStream

/**
 * localabstract 소켓 출력 — 기기 TCP 포트·INTERNET 권한 불필요, adb forward가 직접 지원.
 * 클라이언트(Agent)는 항상 1개 — 단선되면 write가 IOException을 던지고 데몬은 종료(Agent가 재기동)
 */
class MirrorSink(socketName: String) {
    private val server = LocalServerSocket(socketName)
    private var client: LocalSocket? = null
    private var output: OutputStream? = null

    /** 블로킹 accept — 타임아웃은 Watchdog이 프로세스 종료로 처리 */
    fun accept() {
        val socket = server.accept()
        client = socket
        output = BufferedOutputStream(socket.outputStream, 256 * 1024)
    }

    fun writePreamble(display: DisplayState) {
        val stream = requireOutput()
        stream.write(MirrorProtocol.preamble(display.width, display.height))
        stream.flush()
    }

    fun writeFrame(display: DisplayState, frame: EncodedFrame) {
        val stream = requireOutput()
        stream.write(
            MirrorProtocol.packetHeader(frame.isKey, display.width, display.height, frame.ptsMs, frame.payload.size),
        )
        stream.write(frame.payload)
        stream.flush()
    }

    fun close() {
        runCatching { client?.close() }
        runCatching { server.close() }
    }

    private fun requireOutput(): OutputStream {
        return output ?: throw IllegalStateException("accept 전에 write 호출됨")
    }
}
