package com.nebula.controller

/**
 * 최소 JSON 파서·직렬화기 — 의존성 0 원칙 (org.json은 android 프레임워크라 JVM 테스트 불가).
 * 순수 코드: android.* import 금지 (JVM 단위 테스트 대상)
 */
object Json {

    /** 본문 → 평평한 객체. 형식 오류는 빈 맵 (라우터가 필드 검증으로 400 처리) */
    fun parseObject(raw: String): Map<String, Any?> {
        val parser = Parser(raw)
        return runCatching {
            parser.skipWhitespace()
            val value = parser.readValue()
            @Suppress("UNCHECKED_CAST")
            value as? Map<String, Any?> ?: emptyMap()
        }.getOrDefault(emptyMap())
    }

    fun serialize(value: Any?): String {
        val builder = StringBuilder()
        writeValue(builder, value)
        return builder.toString()
    }

    private fun writeValue(builder: StringBuilder, value: Any?) {
        if (value == null) {
            builder.append("null")
            return
        }
        if (value is String) {
            writeString(builder, value)
            return
        }
        if (value is Boolean || value is Int || value is Long) {
            builder.append(value.toString())
            return
        }
        if (value is Double || value is Float) {
            builder.append(value.toString())
            return
        }
        if (value is Map<*, *>) {
            writeObject(builder, value)
            return
        }
        if (value is List<*>) {
            builder.append('[')
            value.forEachIndexed { index, item ->
                if (index > 0) builder.append(',')
                writeValue(builder, item)
            }
            builder.append(']')
            return
        }
        writeString(builder, value.toString())
    }

    private fun writeObject(builder: StringBuilder, map: Map<*, *>) {
        builder.append('{')
        var first = true
        for ((key, item) in map) {
            if (!first) builder.append(',')
            first = false
            writeString(builder, key.toString())
            builder.append(':')
            writeValue(builder, item)
        }
        builder.append('}')
    }

    private fun writeString(builder: StringBuilder, text: String) {
        builder.append('"')
        for (character in text) appendEscaped(builder, character)
        builder.append('"')
    }

    private fun appendEscaped(builder: StringBuilder, character: Char) {
        if (character == '"') {
            builder.append("\\\"")
            return
        }
        if (character == '\\') {
            builder.append("\\\\")
            return
        }
        if (character == '\n') {
            builder.append("\\n")
            return
        }
        if (character == '\r') {
            builder.append("\\r")
            return
        }
        if (character == '\t') {
            builder.append("\\t")
            return
        }
        if (character.code < 0x20) {
            builder.append("\\u").append(character.code.toString(16).padStart(4, '0'))
            return
        }
        builder.append(character)
    }

    private class Parser(private val raw: String) {
        private var position = 0

        fun skipWhitespace() {
            while (position < raw.length && raw[position].isWhitespace()) position += 1
        }

        fun readValue(): Any? {
            skipWhitespace()
            if (position >= raw.length) throw IllegalArgumentException("unexpected end")
            val head = raw[position]
            if (head == '{') return readObject()
            if (head == '[') return readArray()
            if (head == '"') return readString()
            if (head == 't') return readLiteral("true", true)
            if (head == 'f') return readLiteral("false", false)
            if (head == 'n') return readLiteral("null", null)
            return readNumber()
        }

        private fun readObject(): Map<String, Any?> {
            expect('{')
            val result = LinkedHashMap<String, Any?>()
            skipWhitespace()
            if (peek() == '}') {
                position += 1
                return result
            }
            while (true) {
                skipWhitespace()
                val key = readString()
                skipWhitespace()
                expect(':')
                result[key] = readValue()
                skipWhitespace()
                if (peek() == ',') {
                    position += 1
                    continue
                }
                expect('}')
                return result
            }
        }

        private fun readArray(): List<Any?> {
            expect('[')
            val result = ArrayList<Any?>()
            skipWhitespace()
            if (peek() == ']') {
                position += 1
                return result
            }
            while (true) {
                result.add(readValue())
                skipWhitespace()
                if (peek() == ',') {
                    position += 1
                    continue
                }
                expect(']')
                return result
            }
        }

        private fun readString(): String {
            expect('"')
            val builder = StringBuilder()
            while (true) {
                if (position >= raw.length) throw IllegalArgumentException("unterminated string")
                val character = raw[position]
                position += 1
                if (character == '"') return builder.toString()
                if (character != '\\') {
                    builder.append(character)
                    continue
                }
                builder.append(readEscape())
            }
        }

        private fun readEscape(): Char {
            val escape = raw[position]
            position += 1
            if (escape == 'u') {
                val hex = raw.substring(position, position + 4)
                position += 4
                return hex.toInt(16).toChar()
            }
            val mapped = ESCAPES[escape] ?: throw IllegalArgumentException("bad escape: $escape")
            return mapped
        }

        private fun readNumber(): Any {
            val start = position
            while (position < raw.length && raw[position] !in ",}] \t\r\n") position += 1
            val text = raw.substring(start, position)
            val asLong = text.toLongOrNull()
            if (asLong != null) return asLong
            return text.toDouble()
        }

        private fun readLiteral(literal: String, value: Any?): Any? {
            if (!raw.startsWith(literal, position)) throw IllegalArgumentException("bad literal")
            position += literal.length
            return value
        }

        private fun expect(character: Char) {
            if (position >= raw.length || raw[position] != character) {
                throw IllegalArgumentException("expected '$character' at $position")
            }
            position += 1
        }

        private fun peek(): Char {
            if (position >= raw.length) throw IllegalArgumentException("unexpected end")
            return raw[position]
        }
    }

    private val ESCAPES = mapOf(
        '"' to '"', '\\' to '\\', '/' to '/',
        'b' to '\b', 'n' to '\n', 'r' to '\r', 't' to '\t',
        'f' to '\u000C',
    )
}
