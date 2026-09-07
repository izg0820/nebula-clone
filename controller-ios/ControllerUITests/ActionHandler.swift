import UIKit
import XCTest

/** 화면 캡처 결과 — pt 크기는 웹 콘솔의 클릭 → 탭 좌표 환산용 */
struct ScreenshotResult {
    let jpegBase64: String
    let widthPt: Double
    let heightPt: Double
}

/// XCUITest 기반 기기 조작 — 세션 없음, 상시 대기
/// 좌표계는 화면 포인트(pt) 기준. 스프링보드를 기준 앱으로 잡아 시스템 전역 좌표 탭 구현
final class ActionHandler {
    /// 스프링보드 — 어떤 앱이 떠 있어도 화면 좌표 기준 조작 가능
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    func tap(x: Double, y: Double) {
        coordinate(x: x, y: y).tap()
    }

    /// durationMs를 드래그 속도(pt/s)로 환산 — 요청한 시간에 근접한 스와이프
    func swipe(fromX: Double, fromY: Double, toX: Double, toY: Double, durationMs: Double) {
        let start = coordinate(x: fromX, y: fromY)
        let end = coordinate(x: toX, y: toY)

        let distance = ((toX - fromX) * (toX - fromX) + (toY - fromY) * (toY - fromY)).squareRoot()
        let seconds = max(0.05, durationMs / 1000.0)
        let velocity = XCUIGestureVelocity(rawValue: CGFloat(max(10.0, distance / seconds)))

        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: velocity,
                    thenHoldForDuration: 0)
    }

    /// 포커스된 입력 필드에 텍스트 입력 — 키보드가 떠 있어야 동작 (제약: WDA식 커스텀 IME 아님)
    func typeText(_ text: String) {
        springboard.typeText(text)
    }

    /// 접근성 트리 덤프 — bundleId 지정 시 해당 앱, 미지정 시 스프링보드
    /// (스프링보드 덤프는 서드파티 앱이 전면일 때 그 앱의 트리를 담지 못함 — 클라이언트가 bundleId를 넘겨야 함)
    func uiDump(bundleId: String?) -> String {
        guard let bundleId, !bundleId.isEmpty else {
            return springboard.debugDescription
        }
        return XCUIApplication(bundleIdentifier: bundleId).debugDescription
    }

    /// 화면 캡처 → JPEG (스크린샷 폴링 미러링 v0 — 원문이 "슬라이드쇼"라 부른 방식)
    func screenshot() -> ScreenshotResult? {
        let capture = XCUIScreen.main.screenshot()
        let image = capture.image
        // 0.35: 미러링 스트림 대역폭 절충 — 원격(오라클 경유) 시청 대비 프레임 크기 우선
        guard let jpeg = image.jpegData(compressionQuality: 0.35) else { return nil }
        return ScreenshotResult(
            jpegBase64: jpeg.base64EncodedString(),
            widthPt: Double(image.size.width),
            heightPt: Double(image.size.height)
        )
    }

    private func coordinate(x: Double, y: Double) -> XCUICoordinate {
        return springboard
            .coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: x, dy: y))
    }
}
