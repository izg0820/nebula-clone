package com.nebula.controller

import java.util.concurrent.TimeoutException

/**
 * 경로 라우팅 + 토큰·인자 검증 — Agent ControllerClient 계약과 정확히 일치 (iOS 러너 대칭).
 * 검증 상한은 서버 DTO와 동일 기준
 */
class Router(
    private val token: String?,
    private val actions: ActionHandler,
    private val queue: ActionQueue,
    private val tuning: RunnerTuning,
) {
    private companion object {
        const val MAX_COORDINATE = 10_000.0
        const val MAX_TEXT_LENGTH = 4_000
        const val DEFAULT_SWIPE_DURATION_MS = 300.0
    }

    /** UiAutomation 큐 대기+실행 상한 — 초과 시 503 (Agent env로 조정) */
    private val actionTimeoutMs: Long = tuning.actionTimeoutMs
    /** 스와이프 최대 지속 — Agent env로 조정 */
    private val maxSwipeDurationMs: Double = tuning.maxSwipeDurationMs

    private val handlers: Map<String, (Map<String, Any?>) -> HttpResponse> = mapOf(
        "/tap" to ::handleTap,
        "/swipe" to ::handleSwipe,
        "/type" to ::handleType,
        "/press" to ::handlePress,
        "/ui" to ::handleUiDump,
        "/screenshot" to ::handleScreenshot,
    )

    fun route(request: HttpRequest): HttpResponse {
        if (token != null && request.headers["x-nebula-token"] != token) {
            return HttpResponse(401, mapOf("ok" to false, "error" to "unauthorized"))
        }
        // 헬스는 큐를 우회해 즉답 — 긴 스와이프 중에도 수퍼바이저 헬스 폴링이 안 막힘
        if (request.path == "/health") return HttpResponse(200, mapOf("status" to "ok"))

        val handler = handlers[request.path]
            ?: return HttpResponse(404, mapOf("ok" to false, "error" to "unknown path ${request.path}"))
        val body = Json.parseObject(request.body)
        return runQueued { handler(body) }
    }

    private fun runQueued(block: () -> HttpResponse): HttpResponse =
        runCatching { block() }.getOrElse { error ->
            if (error is TimeoutException) {
                return HttpResponse(503, mapOf("ok" to false, "error" to "action queue timeout"))
            }
            throw error
        }

    private fun handleTap(body: Map<String, Any?>): HttpResponse {
        val x = coordinate(body["x"]) ?: return badRequest("x·y는 0~${MAX_COORDINATE.toInt()} 범위 숫자")
        val y = coordinate(body["y"]) ?: return badRequest("x·y는 0~${MAX_COORDINATE.toInt()} 범위 숫자")
        val injected = queue.submit(actionTimeoutMs) { actions.tap(x.toFloat(), y.toFloat()) }
        if (!injected) return HttpResponse(500, mapOf("ok" to false, "error" to "탭 주입 실패"))
        return ok()
    }

    private fun handleSwipe(body: Map<String, Any?>): HttpResponse {
        val fromX = coordinate(body["fromX"])
        val fromY = coordinate(body["fromY"])
        val toX = coordinate(body["toX"])
        val toY = coordinate(body["toY"])
        if (fromX == null || fromY == null || toX == null || toY == null) {
            return badRequest("fromX/fromY/toX/toY는 0~${MAX_COORDINATE.toInt()} 범위 숫자")
        }
        val durationMs = numeric(body["durationMs"]) ?: DEFAULT_SWIPE_DURATION_MS
        if (durationMs <= 0 || durationMs > maxSwipeDurationMs) {
            return badRequest("durationMs는 1~${maxSwipeDurationMs.toInt()} 범위")
        }
        val injected = queue.submit(actionTimeoutMs) {
            actions.swipe(fromX.toFloat(), fromY.toFloat(), toX.toFloat(), toY.toFloat(), durationMs.toLong())
        }
        if (!injected) return HttpResponse(500, mapOf("ok" to false, "error" to "스와이프 주입 실패"))
        return ok()
    }

    private fun handleType(body: Map<String, Any?>): HttpResponse {
        val text = body["text"] as? String ?: return badRequest("text는 ${MAX_TEXT_LENGTH}자 이하 문자열")
        if (text.length > MAX_TEXT_LENGTH) return badRequest("text는 ${MAX_TEXT_LENGTH}자 이하 문자열")
        val typed = queue.submit(actionTimeoutMs) { actions.typeText(text) }
        if (!typed) {
            return HttpResponse(
                500,
                mapOf("ok" to false, "error" to "텍스트 입력 실패 — 편집 가능한 필드에 포커스 필요"),
            )
        }
        return ok()
    }

    private fun handlePress(body: Map<String, Any?>): HttpResponse {
        val button = body["button"] as? String ?: return badRequest("button은 home|back")
        val pressed = queue.submit(actionTimeoutMs) { actions.press(button) }
            ?: return badRequest("button은 home|back")
        if (!pressed) return HttpResponse(500, mapOf("ok" to false, "error" to "버튼 주입 실패"))
        return ok()
    }

    private fun handleUiDump(body: Map<String, Any?>): HttpResponse {
        val bundleId = body["bundleId"] as? String
        val tree = queue.submit(actionTimeoutMs) { actions.uiDump(bundleId) }
        return HttpResponse(200, mapOf("ok" to true, "tree" to tree))
    }

    @Suppress("UNUSED_PARAMETER")
    private fun handleScreenshot(body: Map<String, Any?>): HttpResponse {
        // 캡처만 큐 안 — JPEG 인코딩·base64는 워커 스레드 (iOS 백로그 "인코딩이 러너 점유" 해소)
        val capture = queue.submit(actionTimeoutMs) { actions.captureScreen() }
            ?: return HttpResponse(500, mapOf("ok" to false, "error" to "capture 실패"))
        val encoded = actions.encodeScreenshot(capture)
        return HttpResponse(
            200,
            mapOf(
                "ok" to true,
                "jpegBase64" to encoded.jpegBase64,
                // 값은 px — Agent가 coordWidth/coordHeight로 정규화 (iOS 러너 계약과 필드명 통일)
                "widthPt" to encoded.width,
                "heightPt" to encoded.height,
            ),
        )
    }

    private fun coordinate(raw: Any?): Double? {
        val value = numeric(raw) ?: return null
        if (value < 0 || value > MAX_COORDINATE) return null
        return value
    }

    private fun numeric(raw: Any?): Double? {
        if (raw is Long) return raw.toDouble()
        if (raw is Double) return raw
        if (raw is Int) return raw.toDouble()
        return null
    }

    private fun ok(): HttpResponse = HttpResponse(200, mapOf("ok" to true))

    private fun badRequest(message: String): HttpResponse =
        HttpResponse(400, mapOf("ok" to false, "error" to message))
}
