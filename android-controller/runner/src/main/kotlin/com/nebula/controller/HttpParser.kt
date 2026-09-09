package com.nebula.controller

/**
 * 최소 HTTP/1.1 요청 파서 — Content-Length 본문만 지원 (iOS HttpServer.swift 규약 대칭).
 * 순수 코드: android.* import 금지 (JVM 단위 테스트 대상)
 */
object HttpParser {

    /** 본문 상한 — 초과 시 413 */
    const val MAX_BODY_BYTES = 1 shl 20

    private const val HEADER_TERMINATOR = "\r\n\r\n"

    fun parse(raw: ByteArray, length: Int): ParseResult {
        val text = String(raw, 0, length, Charsets.ISO_8859_1)
        val headerEnd = text.indexOf(HEADER_TERMINATOR)
        if (headerEnd < 0) return ParseResult.NeedMore

        val headerLines = text.substring(0, headerEnd).split("\r\n")
        val requestLine = headerLines.firstOrNull() ?: return ParseResult.Bad(400, "empty request")
        val parts = requestLine.split(" ")
        if (parts.size != 3) return ParseResult.Bad(400, "malformed request line")
        val (method, path) = parts
        if (method != "POST") return ParseResult.Bad(400, "POST only")

        val headers = parseHeaders(headerLines.drop(1))
        if (headers.containsKey("transfer-encoding")) {
            return ParseResult.Bad(501, "chunked not supported")
        }

        val contentLength = parseContentLength(headers["content-length"])
        if (contentLength == null) return ParseResult.Bad(400, "bad content-length")
        if (contentLength > MAX_BODY_BYTES) return ParseResult.Bad(413, "body too large")

        val bodyStart = headerEnd + HEADER_TERMINATOR.length
        val received = length - bodyStart
        if (received < contentLength) return ParseResult.NeedMore

        // 본문은 UTF-8 재해석 (헤더 탐색은 바이트 보존을 위해 ISO-8859-1로 했음)
        val body = String(raw, bodyStart, contentLength, Charsets.UTF_8)
        return ParseResult.Ok(HttpRequest(path = path, headers = headers, body = body))
    }

    private fun parseHeaders(lines: List<String>): Map<String, String> {
        val headers = LinkedHashMap<String, String>()
        for (line in lines) {
            val separator = line.indexOf(':')
            if (separator < 0) continue
            val key = line.substring(0, separator).trim().lowercase()
            headers[key] = line.substring(separator + 1).trim()
        }
        return headers
    }

    /** 누락은 0(본문 없음), 비정수·음수는 null(400) */
    private fun parseContentLength(raw: String?): Int? {
        if (raw == null) return 0
        val parsed = raw.toIntOrNull() ?: return null
        if (parsed < 0) return null
        return parsed
    }
}
