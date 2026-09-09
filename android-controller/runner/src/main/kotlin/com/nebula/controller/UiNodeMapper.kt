package com.nebula.controller

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo

/**
 * AccessibilityNodeInfo → UiNode 변환 — 깊이·노드 수 상한으로 거대 트리 폭주 차단
 * (iOS debugDescription에는 없던 방어)
 */
class UiNodeMapper(
    private val maxDepth: Int = 60,
    private val maxNodes: Int = 5_000,
) {
    private var visited = 0

    fun map(node: AccessibilityNodeInfo, index: Int, depth: Int): UiNode? {
        if (depth == 0) visited = 0
        if (depth > maxDepth) return null
        visited += 1
        if (visited > maxNodes) return null

        val bounds = Rect()
        node.getBoundsInScreen(bounds)

        val children = ArrayList<UiNode>()
        for (childIndex in 0 until node.childCount) {
            val child = node.getChild(childIndex) ?: continue
            val mapped = map(child, childIndex, depth + 1) ?: continue
            children.add(mapped)
        }

        return UiNode(
            index = index,
            text = node.text?.toString() ?: "",
            resourceId = node.viewIdResourceName ?: "",
            className = node.className?.toString() ?: "",
            packageName = node.packageName?.toString() ?: "",
            contentDesc = node.contentDescription?.toString() ?: "",
            checkable = node.isCheckable,
            checked = node.isChecked,
            clickable = node.isClickable,
            enabled = node.isEnabled,
            focusable = node.isFocusable,
            focused = node.isFocused,
            scrollable = node.isScrollable,
            longClickable = node.isLongClickable,
            password = node.isPassword,
            selected = node.isSelected,
            visibleToUser = node.isVisibleToUser,
            bounds = Rect4(bounds.left, bounds.top, bounds.right, bounds.bottom),
            children = children,
        )
    }
}
