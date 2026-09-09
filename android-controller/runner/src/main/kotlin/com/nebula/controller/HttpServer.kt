package com.nebula.controller

import android.util.Log
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * 루프백 전용 HTTP 서버 — adb forward로만 접근 (iOS HttpServer.swift 대칭).
 * accept 1스레드 + 워커 풀: 파싱·직렬화·JPEG 인코딩은 워커에서,
 * UiAutomation 호출만 ActionQueue 단일 스레드 (head-of-line 구조 해소)
 */
class HttpServer(
    private val port: Int,
    private val route: (HttpRequest) -> HttpResponse,
    private val onFatal: (String) -> Unit,
) {
    private companion object {
        const val TAG = "NebulaController"
        const val MAX_CONCURRENT = 16
        const val READ_TIMEOUT_MS = 15_000
        const val ACCEPT_BACKLOG = 32
        const val READ_BUFFER_BYTES = HttpParser.MAX_BODY_BYTES + 8 * 1024
    }

    @Volatile private var isStopping = false
    private var serverSocket: ServerSocket? = null
    private val workers = ThreadPoolExecutor(
        2, MAX_CONCURRENT, 30, TimeUnit.SECONDS,
        SynchronousQueue(), ThreadPoolExecutor.AbortPolicy(),
    )

    fun start() {
        val socket = runCatching {
            ServerSocket(port, ACCEPT_BACKLOG, InetAddress.getByName("127.0.0.1"))
        }.getOrElse {
            onFatal("포트 $port 바인딩 실패: ${it.message}")
            return
        }
        serverSocket = socket
        Thread({ acceptLoop(socket) }, "nebula-accept").start()
    }

    fun stop() {
        isStopping = true
        runCatching { serverSocket?.close() }
        workers.shutdownNow()
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (!isStopping) {
            val connection = runCatching { socket.accept() }.getOrNull() ?: break
            runCatching { workers.execute { handle(connection) } }
                .onFailure { error ->
                    // 포화(AbortPolicy) — 즉시 닫아 적체 방지
                    if (error is RejectedExecutionException) runCatching { connection.close() }
                }
        }
        if (!isStopping) onFatal("accept 루프 종료 — 소켓 오류")
    }

    private fun handle(connection: Socket) {
        connection.use { socket ->
            socket.soTimeout = READ_TIMEOUT_MS
            val response = readAndRoute(socket)
            writeResponse(socket, response)
        }
    }

    private fun readAndRoute(socket: Socket): HttpResponse {
        val buffer = ByteArray(READ_BUFFER_BYTES)
        var length = 0
        val input = socket.getInputStream()
        while (length < buffer.size) {
            val result = HttpParser.parse(buffer, length)
            if (result is ParseResult.Ok) return routeSafely(result.request)
            if (result is ParseResult.Bad) {
                return HttpResponse(result.status, mapOf("ok" to false, "error" to result.reason))
            }
            val read = runCatching { input.read(buffer, length, buffer.size - length) }
                .getOrDefault(-1)
            if (read <= 0) return HttpResponse(400, mapOf("ok" to false, "error" to "incomplete request"))
            length += read
        }
        return HttpResponse(413, mapOf("ok" to false, "error" to "request too large"))
    }

    private fun routeSafely(request: HttpRequest): HttpResponse =
        runCatching { route(request) }.getOrElse { error ->
            Log.e(TAG, "핸들러 예외: ${request.path}", error)
            HttpResponse(500, mapOf("ok" to false, "error" to (error.message ?: "internal error")))
        }

    private fun writeResponse(socket: Socket, response: HttpResponse) {
        val body = Json.serialize(response.body).toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 ${response.status} ${reason(response.status)}\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Connection: close\r\n\r\n"
        runCatching {
            val output = socket.getOutputStream()
            output.write(head.toByteArray(Charsets.ISO_8859_1))
            output.write(body)
            output.flush()
        }.onFailure { error ->
            if (error is IOException) Log.w(TAG, "응답 쓰기 실패: ${error.message}")
        }
    }

    private val reasons = mapOf(
        200 to "OK", 400 to "Bad Request", 401 to "Unauthorized", 404 to "Not Found",
        413 to "Payload Too Large", 500 to "Internal Server Error",
        501 to "Not Implemented", 503 to "Service Unavailable",
    )

    private fun reason(status: Int): String = reasons[status] ?: "Unknown"
}
