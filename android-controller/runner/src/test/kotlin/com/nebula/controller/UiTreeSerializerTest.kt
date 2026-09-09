package com.nebula.controller

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UiTreeSerializerTest {

    private fun node(text: String, children: List<UiNode> = emptyList()): UiNode = UiNode(
        index = 0, text = text, resourceId = "com.app:id/x", className = "android.widget.TextView",
        packageName = "com.app", contentDesc = "", checkable = false, checked = false,
        clickable = true, enabled = true, focusable = false, focused = false, scrollable = false,
        longClickable = false, password = false, selected = false, visibleToUser = true,
        bounds = Rect4(0, 0, 100, 50), children = children,
    )

    @Test
    fun `hierarchy 루트와 uiautomator 호환 속성`() {
        val xml = UiTreeSerializer.serialize(node("버튼"), rotation = 1)

        assertTrue(xml.startsWith("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"1\">"))
        assertTrue(xml.contains("text=\"버튼\""))
        assertTrue(xml.contains("resource-id=\"com.app:id/x\""))
        assertTrue(xml.contains("bounds=\"[0,0][100,50]\""))
        assertTrue(xml.endsWith("</hierarchy>"))
    }

    @Test
    fun `중첩 노드 직렬화`() {
        val xml = UiTreeSerializer.serialize(node("부모", listOf(node("자식"))), rotation = 0)
        assertTrue(xml.contains("text=\"부모\""))
        assertTrue(xml.contains("text=\"자식\""))
    }

    @Test
    fun `XML 특수문자 escape + 제어문자 제거`() {
        val xml = UiTreeSerializer.serialize(node("a<b>&\"'c"), rotation = 0)
        assertTrue(xml.contains("text=\"a&lt;b&gt;&amp;&quot;&apos;c\""))
    }

    @Test
    fun `빈 트리는 빈 hierarchy`() {
        assertEquals(
            "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\"></hierarchy>",
            UiTreeSerializer.serialize(null, rotation = 0),
        )
    }
}
