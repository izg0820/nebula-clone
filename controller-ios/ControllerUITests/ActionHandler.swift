import ObjectiveC.runtime
import UIKit
import XCTest

/**
 * XCUITest quiescence(앱 안정화) 대기 비활성화 — 탭당 ~700ms를 소모하는 주범.
 * 원문 Nebula가 "클릭 52ms vs Appium 702ms"를 만든 핵심이자 WDA가 쓰는 표준 트릭.
 * 비공개 API 패치라 Xcode 버전에 따라 selector가 다를 수 있어 여러 후보를 시도하고 결과를 로깅.
 */
func disableQuiescenceWaits() {
    guard let processClass = NSClassFromString("XCUIApplicationProcess") else {
        NSLog("%@", "quiescence 패치 실패: XCUIApplicationProcess 클래스 없음")
        return
    }

    var patchedSelectors: [String] = []

    // 인자 1개(Bool) 버전
    let singleArgSelectors = ["waitForQuiescenceIncludingAnimationsIdle:"]
    for name in singleArgSelectors {
        let selector = NSSelectorFromString(name)
        guard let method = class_getInstanceMethod(processClass, selector) else { continue }
        let noop: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
        method_setImplementation(method, imp_implementationWithBlock(noop))
        patchedSelectors.append(name)
    }

    // 인자 2개(Bool, Bool) 버전 (신형 Xcode)
    let doubleArgSelectors = ["waitForQuiescenceIncludingAnimationsIdle:isPreEvent:"]
    for name in doubleArgSelectors {
        let selector = NSSelectorFromString(name)
        guard let method = class_getInstanceMethod(processClass, selector) else { continue }
        let noop: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
        method_setImplementation(method, imp_implementationWithBlock(noop))
        patchedSelectors.append(name)
    }

    if patchedSelectors.isEmpty {
        NSLog("%@", "quiescence 패치 실패: 알려진 selector 없음 (Xcode 버전 변화 — 탭이 느리게 동작)")
        return
    }
    NSLog("%@", "quiescence 대기 비활성화: \(patchedSelectors.joined(separator: ", "))")
}

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
    /// 기준 좌표 캐시 — 탭마다 앱 요소 해석(스냅샷 비용)을 반복하지 않도록
    private lazy var origin = springboard.coordinate(withNormalizedOffset: .zero)
    /// WDA 방식 저수준 합성 (실측 탭 755ms → 목표 수십 ms) — 해석 실패 시 nil = XCUI 단독
    private let synthesizer = EventSynthesizer.make()

    func tap(x: Double, y: Double) {
        if let synthesizer, synthesizer.tap(x: x, y: y) { return }
        coordinate(x: x, y: y).tap()
    }

    /// durationMs를 드래그 속도(pt/s)로 환산 — 요청한 시간에 근접한 스와이프
    func swipe(fromX: Double, fromY: Double, toX: Double, toY: Double, durationMs: Double) {
        if let synthesizer,
           synthesizer.swipe(fromX: fromX, fromY: fromY, toX: toX, toY: toY, durationMs: durationMs) {
            return
        }
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

    /// 홈 버튼 — 어떤 앱에서든 홈 화면으로
    func pressHome() {
        XCUIDevice.shared.press(.home)
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
        return origin.withOffset(CGVector(dx: x, dy: y))
    }
}
