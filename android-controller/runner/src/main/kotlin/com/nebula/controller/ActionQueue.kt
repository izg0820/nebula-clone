package com.nebula.controller

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * UiAutomation 호출 직렬화 전용 단일 스레드 — UiAutomation은 동시 호출 불가.
 * 큐 대기+실행 상한 초과는 TimeoutException → 라우터가 503 (러너 무한 적체 방지)
 */
class ActionQueue {
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "nebula-actions")
    }

    fun <T> submit(timeoutMs: Long, block: () -> T): T {
        val future = executor.submit(block)
        return runCatching { future.get(timeoutMs, TimeUnit.MILLISECONDS) }
            .getOrElse { error ->
                if (error is TimeoutException) {
                    future.cancel(true)
                    throw error
                }
                // ExecutionException 언랩 — 원인 예외를 그대로 전파
                throw error.cause ?: error
            }
    }

    fun shutdown() {
        executor.shutdownNow()
    }
}
