package com.nebula.mirror

import android.hardware.display.VirtualDisplay
import android.view.Surface

/** logical display의 현재 크기·회전 (DisplayInfo 리플렉션 결과) */
data class DisplayState(val width: Int, val height: Int, val rotation: Int)

/**
 * hidden API 리플렉션 단일 창구 — 전체 목록 2개뿐, 실패는 즉시 예외 ("한 경로 + 실패 시 시끄럽게").
 * 지원 범위는 보유 기기에서 실측 검증된 조합만 (android-controller/README.md 지원 기기)
 */
object Hidden {
    /**
     * DisplayManager.createVirtualDisplay(String,int,int,int,Surface) hidden static —
     * 미러링 코어. CAPTURE_VIDEO_OUTPUT(signature|privileged) 요구 → shell UID(app_process) 전용
     */
    fun createMirrorDisplay(
        name: String,
        width: Int,
        height: Int,
        displayIdToMirror: Int,
        surface: Surface,
    ): VirtualDisplay {
        val method = Class.forName("android.hardware.display.DisplayManager").getMethod(
            "createVirtualDisplay",
            String::class.java,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Surface::class.java,
        )
        val display = method.invoke(null, name, width, height, displayIdToMirror, surface)
            ?: throw IllegalStateException("createVirtualDisplay가 null 반환 — 권한(CAPTURE_VIDEO_OUTPUT) 확인")
        return display as VirtualDisplay
    }

    /**
     * DisplayManagerGlobal.getInstance().getDisplayInfo(id) → DisplayInfo{logicalWidth,logicalHeight,rotation}
     * — 접힘/펼침·회전 감지용 폴링 대상 (DisplayListener는 인터페이스 진화에 취약해 기각)
     */
    fun displayState(displayId: Int): DisplayState {
        val globalClass = Class.forName("android.hardware.display.DisplayManagerGlobal")
        val global = globalClass.getMethod("getInstance").invoke(null)
        val info = globalClass.getMethod("getDisplayInfo", Int::class.javaPrimitiveType).invoke(global, displayId)
            ?: throw IllegalStateException("displayId $displayId 정보 없음")
        val infoClass = info.javaClass
        return DisplayState(
            width = infoClass.getField("logicalWidth").getInt(info),
            height = infoClass.getField("logicalHeight").getInt(info),
            rotation = infoClass.getField("rotation").getInt(info),
        )
    }
}
