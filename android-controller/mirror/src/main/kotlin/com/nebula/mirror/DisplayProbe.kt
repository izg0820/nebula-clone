package com.nebula.mirror

/**
 * 디스플레이 상태 변화 감지 — 500ms 최소 간격 폴링 (인코더 드레인 루프에서 호출).
 * 접힘/펼침·회전 시 logicalWidth/Height가 바뀌므로 크기 비교만으로 충분
 */
class DisplayProbe(private val displayId: Int, private val intervalMs: Long = 500L) {
    private var lastCheckedAtMs: Long = 0L

    /** 마지막 확인에서 intervalMs가 지났고 크기가 baseline과 다르면 새 상태 반환, 아니면 null */
    fun changedSince(baseline: DisplayState): DisplayState? {
        val now = System.currentTimeMillis()
        if (now - lastCheckedAtMs < intervalMs) return null
        lastCheckedAtMs = now

        val current = Hidden.displayState(displayId)
        if (current.width == baseline.width && current.height == baseline.height) return null
        return current
    }
}
