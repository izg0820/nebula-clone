package com.nebula.controller

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import android.util.Log
import java.util.concurrent.CountDownLatch

/**
 * Nebula Android Controller — "끝나지 않는 instrumentation"이 HTTP 서버를 상시 호스팅.
 * iOS ControllerTests.swift와 대칭: CountDownLatch 무기한 대기 = XCTWaiter 1년 대기.
 * 기동: adb shell am instrument -w -r --no-hidden-api-checks --no-test-api-checks \
 *        -e nebulaPort 8300 -e nebulaToken <값> \
 *        com.nebula.controller/.ControllerInstrumentation
 * (-w 필수 — 없으면 UiAutomation 연결 자체가 생성되지 않음)
 */
class ControllerInstrumentation : Instrumentation() {

    private lateinit var arguments: Bundle
    private val fatalLatch = CountDownLatch(1)

    override fun onCreate(arguments: Bundle) {
        this.arguments = arguments
        super.onCreate(arguments)
        start() // 별도 InstrumentationThread 생성 → onStart() 호출
    }

    /** Looper 없는 비메인 스레드 — 여기서 블로킹해도 프로세스 메인 루퍼는 계속 돈다 */
    override fun onStart() {
        val port = arguments.getString(ARG_PORT)?.toIntOrNull() ?: DEFAULT_PORT
        // 빈 문자열 토큰은 미설정 취급 — "비워서 끄기"가 전면 401 락아웃이 되지 않게 (iOS 동일)
        val token = arguments.getString(ARG_TOKEN)?.trim()?.takeIf { it.isNotEmpty() }

        val automation = uiAutomation
        if (automation == null) {
            fatal("UiAutomation 없음 — am instrument에 -w 필요")
            finish(Activity.RESULT_CANCELED, Bundle())
            return
        }

        val queue = ActionQueue()
        val actions = ActionHandler(automation, context)
        val router = Router(token = token, actions = actions, queue = queue)
        val server = HttpServer(port = port, route = router::route, onFatal = ::fatal)

        server.start()
        Log.i(TAG, "controller listening 127.0.0.1:$port tokenRequired=${token != null}")

        // 치명 실패 시에만 풀림 — 러너를 실제로 끝내 "리스너 없는 유령 러너" 방지 (iOS 패턴)
        fatalLatch.await()
        server.stop()
        queue.shutdown()
        finish(Activity.RESULT_OK, Bundle())
    }

    private fun fatal(message: String) {
        Log.e(TAG, "치명 실패: $message")
        fatalLatch.countDown()
    }

    companion object {
        private const val TAG = "NebulaController"
        const val ARG_PORT = "nebulaPort"
        const val ARG_TOKEN = "nebulaToken"
        const val DEFAULT_PORT = 8300
    }
}
