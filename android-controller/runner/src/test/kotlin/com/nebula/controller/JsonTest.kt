package com.nebula.controller

import org.junit.Assert.assertEquals
import org.junit.Test

class JsonTest {

    @Test
    fun `요청 본문 파싱 - 숫자·문자열·불리언`() {
        val parsed = Json.parseObject("""{"x": 200, "y": 500.5, "text": "한글 \"인용\"", "flag": true}""")

        assertEquals(200L, parsed["x"])
        assertEquals(500.5, parsed["y"])
        assertEquals("한글 \"인용\"", parsed["text"])
        assertEquals(true, parsed["flag"])
    }

    @Test
    fun `형식 오류는 빈 맵 - 라우터가 필드 검증으로 400 처리`() {
        assertEquals(emptyMap<String, Any?>(), Json.parseObject("not json"))
        assertEquals(emptyMap<String, Any?>(), Json.parseObject("[1,2]"))
        assertEquals(emptyMap<String, Any?>(), Json.parseObject(""))
    }

    @Test
    fun `직렬화 - 문자열 escape와 중첩`() {
        val json = Json.serialize(
            linkedMapOf("ok" to true, "tree" to "<a b=\"c\">\n</a>", "n" to 42),
        )
        assertEquals("""{"ok":true,"tree":"<a b=\"c\">\n</a>","n":42}""", json)
    }

    @Test
    fun `round-trip - 유니코드 이스케이프`() {
        val parsed = Json.parseObject("""{"t":"한글"}""")
        assertEquals("한글", parsed["t"])
    }
}
