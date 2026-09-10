package com.nebula.controller

import android.app.UiAutomation
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.InputEvent
import android.view.KeyEvent
import android.view.MotionEvent
import java.lang.reflect.Method

/**
 * MotionEvent/KeyEvent 합성 + 주입 — 전부 공개 API.
 * 유일한 선택적 hidden 호출: injectInputEvent 3인자(waitForAnimations=false, @TestApi) —
 * 실패 시 public 2인자 폴백 (iOS EventSynthesizer 우선 + XCUI 폴백 구조와 대칭)
 */
class InputSynthesizer(
    private val automation: UiAutomation,
    /** 스와이프 MOVE 간격 (ms, ~120Hz) — Agent env로 조정 */
    private val stepMs: Long = DEFAULT_STEP_MS,
) {

    companion object {
        private const val TAG = "NebulaController"
        const val DEFAULT_STEP_MS = 8L
        private const val MAX_STEPS = 200L
    }

    /** waitForAnimations=false 오버로드 — 없으면 null(폴백), 1회만 로그 */
    private val fastInject: Method? = runCatching {
        UiAutomation::class.java.getMethod(
            "injectInputEvent",
            InputEvent::class.java,
            Boolean::class.javaPrimitiveType,
            Boolean::class.javaPrimitiveType,
        )
    }.onFailure { Log.w(TAG, "3인자 injectInputEvent 미발견 — 애니메이션 대기 포함 경로 사용") }
        .getOrNull()

    private fun inject(event: InputEvent, sync: Boolean): Boolean {
        val fast = fastInject ?: return automation.injectInputEvent(event, sync)
        return runCatching { fast.invoke(automation, event, sync, false) as Boolean }
            .getOrElse { automation.injectInputEvent(event, sync) }
    }

    fun tap(x: Float, y: Float): Boolean {
        val downTime = SystemClock.uptimeMillis()
        val down = motion(downTime, downTime, MotionEvent.ACTION_DOWN, x, y)
        val up = motion(downTime, downTime, MotionEvent.ACTION_UP, x, y)
        return runCatching { inject(down, true) && inject(up, true) }
            .getOrDefault(false)
            .also {
                down.recycle()
                up.recycle()
            }
    }

    fun swipe(fromX: Float, fromY: Float, toX: Float, toY: Float, durationMs: Long): Boolean {
        val steps = (durationMs / stepMs).coerceIn(2L, MAX_STEPS)
        val downTime = SystemClock.uptimeMillis()

        val down = motion(downTime, downTime, MotionEvent.ACTION_DOWN, fromX, fromY)
        val downInjected = inject(down, true).also { down.recycle() }
        if (!downInjected) return false

        for (step in 1..steps) {
            val progress = step.toFloat() / steps
            val x = fromX + (toX - fromX) * progress
            val y = fromY + (toY - fromY) * progress
            // 절대시각 기반 스케줄 — sleep 누적 드리프트 방지
            val targetTime = downTime + durationMs * step / steps
            val wait = targetTime - SystemClock.uptimeMillis()
            if (wait > 0) SystemClock.sleep(wait)
            val move = motion(downTime, targetTime, MotionEvent.ACTION_MOVE, x, y)
            val moved = inject(move, true).also { move.recycle() }
            if (!moved) return false
        }

        val upTime = SystemClock.uptimeMillis()
        val up = motion(downTime, upTime, MotionEvent.ACTION_UP, toX, toY)
        return inject(up, true).also { up.recycle() }
    }

    fun pressKey(keyCode: Int): Boolean {
        val time = SystemClock.uptimeMillis()
        val down = KeyEvent(time, time, KeyEvent.ACTION_DOWN, keyCode, 0)
        val up = KeyEvent(time, time, KeyEvent.ACTION_UP, keyCode, 0)
        return inject(down, true) && inject(up, true)
    }

    fun injectKey(event: KeyEvent): Boolean = inject(event, true)

    private fun motion(downTime: Long, eventTime: Long, action: Int, x: Float, y: Float): MotionEvent =
        MotionEvent.obtain(downTime, eventTime, action, x, y, 0).apply {
            // SOURCE_TOUCHSCREEN 필수 — SOURCE_UNKNOWN 이벤트는 입력 시스템이 드롭
            source = InputDevice.SOURCE_TOUCHSCREEN
        }
}
