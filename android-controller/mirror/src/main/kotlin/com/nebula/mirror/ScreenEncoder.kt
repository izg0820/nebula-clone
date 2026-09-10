package com.nebula.mirror

import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat

/** 인코더가 뽑아낸 액세스 유닛 1개 (SPS/PPS 인밴드 처리 후) */
class EncodedFrame(val isKey: Boolean, val ptsMs: Long, val payload: ByteArray)

/** 세션 종료 사유 — 호출자(데몬 루프)가 재구성/종료를 결정 */
sealed class SessionEnd {
    class DisplayChanged(val next: DisplayState) : SessionEnd()
    object Stopped : SessionEnd()
}

private const val MIME_H264 = "video/avc"
private const val DEQUEUE_TIMEOUT_US = 100_000L
private const val US_PER_MS = 1_000L

/**
 * 인코딩 세션 1개 = 해상도 1개 — MediaCodec(H.264) 입력 Surface에 hidden 가상 디스플레이를 물림.
 * 해상도가 바뀌면(접힘/회전) 세션을 통째로 재구성한다 (새 SPS/PPS 자동 확보).
 * 인코더 파라미터(비트레이트·fps·키프레임 간격·정지 화면 재발행)는 전부 Agent env에서 주입
 */
class EncoderSession(
    private val display: DisplayState,
    private val displayId: Int,
    private val tuning: EncoderTuning,
) {
    private val codec = MediaCodec.createEncoderByType(MIME_H264)
    private var virtualDisplay: VirtualDisplay? = null
    /** CODEC_CONFIG(SPS/PPS) 보관 — 모든 키프레임 앞에 인밴드 재삽입 (자립 키프레임) */
    private var configBytes: ByteArray? = null

    fun start() {
        val format = MediaFormat.createVideoFormat(MIME_H264, display.width, display.height)
        format.setInteger(
            MediaFormat.KEY_COLOR_FORMAT,
            MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface,
        )
        format.setInteger(MediaFormat.KEY_BIT_RATE, tuning.bitRate)
        format.setInteger(MediaFormat.KEY_FRAME_RATE, tuning.fps)
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, tuning.iframeIntervalSec)
        // 정지 화면 재발행 — 없으면 늦게 합류한 시청자가 다음 화면 변화까지 검은 화면 (Android 함정)
        format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, tuning.repeatFrameMs * US_PER_MS)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)

        val surface = codec.createInputSurface()
        codec.start()
        virtualDisplay = Hidden.createMirrorDisplay(
            "nebula-mirror", display.width, display.height, displayId, surface,
        )
    }

    /**
     * 드레인 루프 — 프레임마다 emit 호출, 디스플레이 변화 감지 시 반환.
     * emit이 던지는 IOException(클라이언트 단선)은 호출자로 전파
     */
    fun drainUntilChange(probe: DisplayProbe, emit: (EncodedFrame) -> Unit): SessionEnd {
        val bufferInfo = MediaCodec.BufferInfo()
        while (true) {
            val next = probe.changedSince(display)
            if (next != null) return SessionEnd.DisplayChanged(next)

            val index = codec.dequeueOutputBuffer(bufferInfo, DEQUEUE_TIMEOUT_US)
            if (index < 0) continue

            val buffer = codec.getOutputBuffer(index) ?: continue
            val bytes = ByteArray(bufferInfo.size)
            buffer.position(bufferInfo.offset)
            buffer.get(bytes)
            codec.releaseOutputBuffer(index, false)

            if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                configBytes = bytes
                continue
            }
            emit(toFrame(bufferInfo, bytes))
        }
    }

    fun release() {
        // 가상 디스플레이 먼저 — 인코더 정지 후 Surface에 그리는 경합 방지
        virtualDisplay?.release()
        virtualDisplay = null
        runCatching { codec.stop() }
        codec.release()
    }

    private fun toFrame(bufferInfo: MediaCodec.BufferInfo, bytes: ByteArray): EncodedFrame {
        val isKey = bufferInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
        val ptsMs = bufferInfo.presentationTimeUs / 1_000L
        if (!isKey) return EncodedFrame(isKey = false, ptsMs = ptsMs, payload = bytes)

        val config = configBytes
            ?: throw IllegalStateException("키프레임 전 CODEC_CONFIG 미수신 — 인코더 계약 위반")
        return EncodedFrame(isKey = true, ptsMs = ptsMs, payload = config + bytes)
    }
}
