package com.nebula.controller

/** 파싱된 요청 — 헤더 키는 소문자 정규화 */
data class HttpRequest(
    val path: String,
    val headers: Map<String, String>,
    val body: String,
)

data class HttpResponse(
    val status: Int,
    val body: Map<String, Any?>,
)

/** 증분 파싱 결과 — iOS HttpServer.swift의 HttpParseResult와 대칭 */
sealed interface ParseResult {
    /** 요청이 아직 완성되지 않음 — 더 읽어야 함 */
    data object NeedMore : ParseResult

    /** 형식 오류 — 해당 상태로 응답 후 연결 종료 */
    data class Bad(val status: Int, val reason: String) : ParseResult

    data class Ok(val request: HttpRequest) : ParseResult
}
