package com.nebula.controller

/** 접근성 트리의 순수 표현 — 직렬화·테스트가 android 의존 없이 돌게 분리 */
data class Rect4(val left: Int, val top: Int, val right: Int, val bottom: Int)

data class UiNode(
    val index: Int,
    val text: String,
    val resourceId: String,
    val className: String,
    val packageName: String,
    val contentDesc: String,
    val checkable: Boolean,
    val checked: Boolean,
    val clickable: Boolean,
    val enabled: Boolean,
    val focusable: Boolean,
    val focused: Boolean,
    val scrollable: Boolean,
    val longClickable: Boolean,
    val password: Boolean,
    val selected: Boolean,
    val visibleToUser: Boolean,
    val bounds: Rect4,
    val children: List<UiNode>,
)
