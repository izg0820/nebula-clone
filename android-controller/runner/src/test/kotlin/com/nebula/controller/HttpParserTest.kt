package com.nebula.controller

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpParserTest {

    private fun parse(text: String): ParseResult {
        val bytes = text.toByteArray(Charsets.UTF_8)
        return HttpParser.parse(bytes, bytes.size)
    }

    @Test
    fun `정상 POST 요청 파싱 - 헤더 소문자 정규화 + UTF-8 본문`() {
        val body = "{\"text\":\"한글\"}"
        val bodyBytes = body.toByteArray(Charsets.UTF_8)
        val raw = "POST /type HTTP/1.1\r\nX-Nebula-Token: t\r\nContent-Length: ${bodyBytes.size}\r\n\r\n$body"

        val result = parse(raw)

        assertTrue(result is ParseResult.Ok)
        val request = (result as ParseResult.Ok).request
        assertEquals("/type", request.path)
        assertEquals("t", request.headers["x-nebula-token"])
        assertEquals(body, request.body)
    }

    @Test
    fun `본문이 덜 도착하면 NeedMore`() {
        val result = parse("POST /tap HTTP/1.1\r\nContent-Length: 10\r\n\r\n{\"x\"")
        assertTrue(result is ParseResult.NeedMore)
    }

    @Test
    fun `헤더 미완성도 NeedMore`() {
        assertTrue(parse("POST /tap HTTP/1.1\r\nContent-") is ParseResult.NeedMore)
    }

    @Test
    fun `POST 외 메서드는 400`() {
        val result = parse("GET /health HTTP/1.1\r\n\r\n")
        assertEquals(400, (result as ParseResult.Bad).status)
    }

    @Test
    fun `chunked는 501, 비정수·음수 Content-Length는 400, 초과는 413`() {
        val chunked = parse("POST /tap HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")
        assertEquals(501, (chunked as ParseResult.Bad).status)

        val badLength = parse("POST /tap HTTP/1.1\r\nContent-Length: abc\r\n\r\n")
        assertEquals(400, (badLength as ParseResult.Bad).status)

        val negative = parse("POST /tap HTTP/1.1\r\nContent-Length: -1\r\n\r\n")
        assertEquals(400, (negative as ParseResult.Bad).status)

        val huge = parse("POST /tap HTTP/1.1\r\nContent-Length: ${HttpParser.MAX_BODY_BYTES + 1}\r\n\r\n")
        assertEquals(413, (huge as ParseResult.Bad).status)
    }

    @Test
    fun `Content-Length 없는 요청은 빈 본문으로 통과`() {
        val result = parse("POST /screenshot HTTP/1.1\r\n\r\n")
        assertEquals("", (result as ParseResult.Ok).request.body)
    }
}
