package com.nebula.controller

/**
 * UiNode 트리 → XML — uiautomator dump 형식과 호환되는 속성 이름·구조 (기존 툴·눈이 읽히게).
 * 순수 코드: JVM 단위 테스트 대상
 */
object UiTreeSerializer {

    fun serialize(root: UiNode?, rotation: Int): String {
        val builder = StringBuilder()
        builder.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>")
        builder.append("<hierarchy rotation=\"").append(rotation).append("\">")
        if (root != null) appendNode(builder, root)
        builder.append("</hierarchy>")
        return builder.toString()
    }

    private fun appendNode(builder: StringBuilder, node: UiNode) {
        builder.append("<node")
        attribute(builder, "index", node.index.toString())
        attribute(builder, "text", node.text)
        attribute(builder, "resource-id", node.resourceId)
        attribute(builder, "class", node.className)
        attribute(builder, "package", node.packageName)
        attribute(builder, "content-desc", node.contentDesc)
        attribute(builder, "checkable", node.checkable.toString())
        attribute(builder, "checked", node.checked.toString())
        attribute(builder, "clickable", node.clickable.toString())
        attribute(builder, "enabled", node.enabled.toString())
        attribute(builder, "focusable", node.focusable.toString())
        attribute(builder, "focused", node.focused.toString())
        attribute(builder, "scrollable", node.scrollable.toString())
        attribute(builder, "long-clickable", node.longClickable.toString())
        attribute(builder, "password", node.password.toString())
        attribute(builder, "selected", node.selected.toString())
        attribute(builder, "visible-to-user", node.visibleToUser.toString())
        val bounds = node.bounds
        attribute(builder, "bounds", "[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]")
        builder.append('>')
        for (child in node.children) appendNode(builder, child)
        builder.append("</node>")
    }

    private fun attribute(builder: StringBuilder, name: String, value: String) {
        builder.append(' ').append(name).append("=\"")
        for (character in value) appendEscaped(builder, character)
        builder.append('"')
    }

    private fun appendEscaped(builder: StringBuilder, character: Char) {
        if (character == '&') {
            builder.append("&amp;")
            return
        }
        if (character == '<') {
            builder.append("&lt;")
            return
        }
        if (character == '>') {
            builder.append("&gt;")
            return
        }
        if (character == '"') {
            builder.append("&quot;")
            return
        }
        if (character == '\'') {
            builder.append("&apos;")
            return
        }
        // XML 1.0 불허 문자(제어문자 등)는 제거 — 파서가 깨지는 것 방지
        if (character.code < 0x20 && character != '\n' && character != '\t' && character != '\r') return
        if (character.code == 0xFFFE || character.code == 0xFFFF) return
        builder.append(character)
    }
}
