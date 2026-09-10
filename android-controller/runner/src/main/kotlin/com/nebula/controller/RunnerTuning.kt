package com.nebula.controller

import android.os.Bundle

/**
 * 러너 액션 타이밍 — 전부 Agent env에서 am instrument -e 인자로 전달 (미지정 시 기본값).
 * AndroidSupervisor.runnerTuningArgs()와 인자 이름 계약 일치
 */
class RunnerTuning(
    /** UiAutomation 큐 대기+실행 상한 (ms) — 초과 시 503 */
    val actionTimeoutMs: Long,
    /** 스와이프 MOVE 간격 (ms) */
    val swipeStepMs: Long,
    /** 스와이프 최대 지속 (ms) — 초과 요청은 400 */
    val maxSwipeDurationMs: Double,
) {
    companion object {
        const val ARG_ACTION_TIMEOUT = "nebulaActionTimeoutMs"
        const val ARG_SWIPE_STEP = "nebulaSwipeStepMs"
        const val ARG_MAX_SWIPE = "nebulaMaxSwipeMs"

        const val DEFAULT_ACTION_TIMEOUT_MS = 9_000L
        const val DEFAULT_SWIPE_STEP_MS = 8L
        const val DEFAULT_MAX_SWIPE_MS = 8_000.0

        fun from(arguments: Bundle): RunnerTuning {
            return RunnerTuning(
                actionTimeoutMs = positiveLong(arguments, ARG_ACTION_TIMEOUT, DEFAULT_ACTION_TIMEOUT_MS),
                swipeStepMs = positiveLong(arguments, ARG_SWIPE_STEP, DEFAULT_SWIPE_STEP_MS),
                maxSwipeDurationMs = positiveLong(arguments, ARG_MAX_SWIPE, DEFAULT_MAX_SWIPE_MS.toLong()).toDouble(),
            )
        }

        /** 잘못된 값(0·음수·비정수)은 기본값으로 폴백 — 러너가 기동 불능이 되지 않게 */
        private fun positiveLong(arguments: Bundle, key: String, fallback: Long): Long {
            val parsed = arguments.getString(key)?.toLongOrNull() ?: return fallback
            return if (parsed > 0) parsed else fallback
        }
    }
}
