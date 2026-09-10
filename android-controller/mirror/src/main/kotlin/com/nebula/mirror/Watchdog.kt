package com.nebula.mirror

import kotlin.system.exitProcess

/**
 * 접속 데드라인 감시 — Agent가 forward를 못 잇거나 죽었는데 데몬만 남는 고아 방지.
 * LocalServerSocket.accept()는 타임아웃이 없어 별도 스레드에서 프로세스째 종료한다
 */
class Watchdog(private val deadlineMs: Long) {
    @Volatile private var isSatisfied = false

    fun arm(reason: String) {
        val thread = Thread {
            Thread.sleep(deadlineMs)
            if (isSatisfied) return@Thread
            System.err.println("[nebula-mirror] $reason ${deadlineMs}ms 초과 — 종료")
            exitProcess(2)
        }
        thread.isDaemon = true
        thread.start()
    }

    fun satisfy() {
        isSatisfied = true
    }
}
