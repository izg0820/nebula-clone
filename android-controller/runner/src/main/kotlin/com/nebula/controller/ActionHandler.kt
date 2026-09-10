package com.nebula.controller

import android.accessibilityservice.AccessibilityService
import android.app.UiAutomation
import android.content.Context
import android.graphics.Bitmap
import android.os.Bundle
import android.view.KeyCharacterMap
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo

/** 인코딩 결과 — Router가 응답으로 변환 */
data class EncodedScreenshot(val jpegBase64: String, val width: Int, val height: Int)

/**
 * UiAutomation 기반 기기 조작 — 전부 공개 API (hidden API는 InputSynthesizer의 선택 1개뿐).
 * 좌표계는 px. 모든 메서드는 ActionQueue 단일 스레드에서 호출됨 (captureScreen 인코딩 제외)
 */
class ActionHandler(
    private val automation: UiAutomation,
    private val context: Context,
    swipeStepMs: Long = InputSynthesizer.DEFAULT_STEP_MS,
) {
    private val synthesizer = InputSynthesizer(automation, swipeStepMs)
    private val mapper = UiNodeMapper()

    /** press 버튼 → 접근성 글로벌 액션 (KEYCODE_HOME은 PhoneWindowManager 정책에 취약해 미사용) */
    private val globalActions = mapOf(
        "home" to AccessibilityService.GLOBAL_ACTION_HOME,
        "back" to AccessibilityService.GLOBAL_ACTION_BACK,
    )

    fun tap(x: Float, y: Float): Boolean = synthesizer.tap(x, y)

    fun swipe(fromX: Float, fromY: Float, toX: Float, toY: Float, durationMs: Long): Boolean =
        synthesizer.swipe(fromX, fromY, toX, toY, durationMs)

    /**
     * 텍스트 입력 — ① 포커스 노드 ACTION_SET_TEXT (한글 OK, IME 불필요)
     * ② 폴백: KeyCharacterMap 키 이벤트 (ASCII 한정, 실제 키 입력을 기대하는 앱용)
     */
    fun typeText(text: String): Boolean {
        if (setTextOnFocusedNode(text)) return true
        return injectAsciiKeyEvents(text)
    }

    /** @return null = 알 수 없는 버튼(400), false = 주입 실패(500) */
    fun press(button: String): Boolean? {
        val action = globalActions[button] ?: return null
        return automation.performGlobalAction(action)
    }

    fun uiDump(bundleId: String?): String {
        val rotation = currentRotation()
        if (bundleId.isNullOrEmpty()) {
            return UiTreeSerializer.serialize(rootNode()?.let { mapper.map(it, 0, 0) }, rotation)
        }
        val window = automation.windows.firstOrNull { info ->
            info.root?.packageName?.toString() == bundleId
        }
        return UiTreeSerializer.serialize(window?.root?.let { mapper.map(it, 0, 0) }, rotation)
    }

    /** 캡처만 (큐 안) — 인코딩은 encodeScreenshot(워커 스레드) */
    fun captureScreen(): Bitmap? = automation.takeScreenshot()

    fun encodeScreenshot(bitmap: Bitmap): EncodedScreenshot {
        val safe = toSoftwareBitmap(bitmap)
        val output = java.io.ByteArrayOutputStream(256 * 1024)
        safe.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, output)
        val encoded = android.util.Base64.encodeToString(output.toByteArray(), android.util.Base64.NO_WRAP)
        return EncodedScreenshot(jpegBase64 = encoded, width = bitmap.width, height = bitmap.height)
    }

    /** takeScreenshot이 hardware bitmap을 줄 수 있음 — compress 전에 소프트웨어 사본으로 */
    private fun toSoftwareBitmap(bitmap: Bitmap): Bitmap {
        if (bitmap.config != Bitmap.Config.HARDWARE) return bitmap
        return bitmap.copy(Bitmap.Config.ARGB_8888, false)
    }

    private fun setTextOnFocusedNode(text: String): Boolean {
        val root = rootNode() ?: return false
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
        if (!focused.isEditable) return false
        val arguments = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
    }

    private fun injectAsciiKeyEvents(text: String): Boolean {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        val events = map.getEvents(text.toCharArray()) ?: return false
        return events.all { event -> synthesizer.injectKey(event) }
    }

    private fun rootNode(): AccessibilityNodeInfo? = automation.rootInActiveWindow

    private fun currentRotation(): Int {
        val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
        return windowManager?.defaultDisplay?.rotation ?: 0
    }

    private companion object {
        /** iOS 러너 0.35와 동일 절충 — 프레임 크기 우선 */
        const val JPEG_QUALITY = 35
    }
}
