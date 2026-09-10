package com.nebula.mirror

import java.io.IOException
import kotlin.system.exitProcess

private const val STATS_INTERVAL_FRAMES = 100

/**
 * 미러링 데몬 — app_process(shell UID) 전용. instrumentation(앱 UID)은 CAPTURE_VIDEO_OUTPUT이
 * 없어 러너 APK와 분리됨. 기동:
 *   CLASSPATH=/data/local/tmp/nebula-mirror.jar app_process / com.nebula.mirror.MirrorDaemonKt
 */
fun main(argv: Array<String>) {
    val args = runCatching { Args.parse(argv) }.getOrElse { error ->
        System.err.println("[nebula-mirror] 인자 오류: ${error.message}")
        exitProcess(64)
    }
    if (args.isProbe) {
        runProbe(args.displayId)
        return
    }
    runDaemon(args)
}

/** U2 게이트 판정 — hidden API 존재·동작을 기기에서 확인 (읽기 전용, 가상 디스플레이 미생성) */
private fun runProbe(displayId: Int) {
    val createResult = runCatching {
        Class.forName("android.hardware.display.DisplayManager").getMethod(
            "createVirtualDisplay",
            String::class.java, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType, android.view.Surface::class.java,
        )
    }
    val stateResult = runCatching { Hidden.displayState(displayId) }

    println("U2 createVirtualDisplay(hidden static): ${createResult.fold({ "FOUND" }, { "MISSING — $it" })}")
    println("U2 getDisplayInfo: ${stateResult.fold({ "OK $it" }, { "FAIL — $it" })}")
    if (createResult.isFailure || stateResult.isFailure) exitProcess(1)
}

private fun runDaemon(args: Args): Nothing {
    val watchdog = Watchdog(args.acceptDeadlineMs)
    watchdog.arm("클라이언트 접속 대기")
    val sink = MirrorSink(args.socketName)
    System.err.println("[nebula-mirror] 소켓 대기: ${args.socketName}")
    sink.accept()
    watchdog.satisfy()

    val display = Hidden.displayState(args.displayId)
    System.err.println("[nebula-mirror] 세션 시작: ${display.width}x${display.height} rotation=${display.rotation}")
    sink.writePreamble(display)

    try {
        streamForever(sink, args, display)
    } catch (error: IOException) {
        // 클라이언트(Agent) 단선 — 정상 종료, Agent가 필요 시 재기동
        System.err.println("[nebula-mirror] 클라이언트 단선 — 종료 (${error.message})")
        sink.close()
        exitProcess(0)
    } catch (error: Throwable) {
        System.err.println("[nebula-mirror] 치명 오류 — ${error.stackTraceToString()}")
        sink.close()
        exitProcess(1)
    }
}

private fun streamForever(sink: MirrorSink, args: Args, initial: DisplayState): Nothing {
    var display = initial
    val stats = FrameStats()
    while (true) {
        val session = EncoderSession(display, args.displayId, args.tuning)
        session.start()
        try {
            val probe = DisplayProbe(args.displayId, args.tuning.swapPollMs)
            val end = session.drainUntilChange(probe) { frame ->
                sink.writeFrame(display, frame)
                stats.count(frame)
            }
            if (end is SessionEnd.DisplayChanged) {
                System.err.println(
                    "[nebula-mirror] 해상도 변경: ${display.width}x${display.height} → ${end.next.width}x${end.next.height} — 세션 재구성",
                )
                display = end.next
            }
        } finally {
            session.release()
        }
    }
}

/** 프레임 통계 — stderr로 주기 보고 (수동 스모크·fps 실측용) */
private class FrameStats {
    private var frames = 0L
    private var bytes = 0L
    private var windowStartedAtMs = System.currentTimeMillis()

    fun count(frame: EncodedFrame) {
        frames += 1
        bytes += frame.payload.size
        if (frames % STATS_INTERVAL_FRAMES != 0L) return

        val elapsedMs = System.currentTimeMillis() - windowStartedAtMs
        val fps = STATS_INTERVAL_FRAMES * 1_000L / elapsedMs.coerceAtLeast(1)
        System.err.println("[nebula-mirror] frames=$frames fps=$fps avgBytes=${bytes / frames}")
        windowStartedAtMs = System.currentTimeMillis()
    }
}
