import ObjectiveC.runtime
import UIKit
import XCTest

/**
 * WDA 방식 저수준 이벤트 합성 — XCUICoordinate.tap()이 매번 수행하는
 * 접근성 스냅샷 2회(~230ms) + interruption 체크 + 후처리(~530ms)를 전부 우회하고
 * HID 이벤트를 testmanagerd에 직접 주입한다 (실측: 탭 755ms의 주범이 이 경로).
 *
 * 비공개 API(XCSynthesizedEventRecord / XCPointerEventPath / XCTRunnerDaemonSession) 사용 —
 * 기동 시 전부 해석에 성공했을 때만 활성화(make()가 nil이면 비활성), 호출 실패 시
 * ActionHandler가 기존 XCUI 경로로 폴백한다. quiescence 패치와 같은 성격의 버전 리스크.
 */
final class EventSynthesizer {
    private typealias AllocFn = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>
    private typealias InitRecordFn = @convention(c) (AnyObject, Selector, NSString, Int)
        -> Unmanaged<AnyObject>
    private typealias InitTouchFn = @convention(c) (AnyObject, Selector, CGPoint, TimeInterval)
        -> Unmanaged<AnyObject>
    private typealias MoveFn = @convention(c) (AnyObject, Selector, CGPoint, TimeInterval) -> Void
    private typealias LiftFn = @convention(c) (AnyObject, Selector, TimeInterval) -> Void
    private typealias AddPathFn = @convention(c) (AnyObject, Selector, AnyObject) -> Void
    // 완료 블록은 AnyObject로 전달 — @convention(c) 파라미터의 블록은 Swift가 @noescape로
    // 취급해 비동기 완료 시점에 "escaped" 런타임 크래시가 남 (실기기에서 실측)
    private typealias SynthesizeFn = @convention(c) (AnyObject, Selector, AnyObject, AnyObject) -> Void

    /// 탭 누름 유지 시간 — 실제 손가락 탭에 준하는 값
    private static let tapHoldSeconds: TimeInterval = 0.05
    /// 이벤트 완료 콜백 대기 상한 — 초과 시 전달된 것으로 간주 (폴백 재실행 = 이중 탭 위험)
    private static let completionTimeoutSeconds: TimeInterval = 2.0

    private let recordClass: AnyClass
    private let pathClass: AnyClass
    /// 세션은 캐시하지 않고 매 호출 시 sharedSession을 다시 얻는다 (WDA 동일) —
    /// 초기화 시점 참조를 unretained 보관하면 세션 교체 후 죽은 참조 호출로 segfault (실기기 실측)
    private let sessionClass: AnyClass
    private let sharedSessionSel = NSSelectorFromString("sharedSession")
    private let allocFn: AllocFn
    private let initRecordFn: InitRecordFn
    private let initTouchFn: InitTouchFn
    private let moveFn: MoveFn
    private let liftFn: LiftFn
    private let addPathFn: AddPathFn
    private let synthesizeFn: SynthesizeFn

    private let allocSel = NSSelectorFromString("alloc")
    private let initRecordSel = NSSelectorFromString("initWithName:interfaceOrientation:")
    private let initTouchSel = NSSelectorFromString("initForTouchAtPoint:offset:")
    private let moveSel = NSSelectorFromString("moveToPoint:atOffset:")
    private let liftSel = NSSelectorFromString("liftUpAtOffset:")
    private let addPathSel = NSSelectorFromString("addPointerEventPath:")
    private let synthesizeSel = NSSelectorFromString("synthesizeEvent:completion:")

    /// 비공개 API 전체 해석 — 하나라도 없으면 nil (호출부는 XCUI 폴백 단독 운행)
    static func make() -> EventSynthesizer? {
        guard let recordClass = NSClassFromString("XCSynthesizedEventRecord"),
              let pathClass = NSClassFromString("XCPointerEventPath"),
              let sessionClass = NSClassFromString("XCTRunnerDaemonSession") else {
            NSLog("%@", "저수준 이벤트 합성 비활성: 비공개 클래스 미발견 — XCUI 경로 사용")
            return nil
        }
        guard let sessionUnmanaged = (sessionClass as AnyObject)
            .perform(NSSelectorFromString("sharedSession")) else {
            NSLog("%@", "저수준 이벤트 합성 비활성: XCTRunnerDaemonSession.sharedSession 없음")
            return nil
        }
        let session = sessionUnmanaged.takeUnretainedValue()

        guard let synthesizer = EventSynthesizer(
            recordClass: recordClass, pathClass: pathClass,
            sessionClass: sessionClass, session: session
        ) else {
            NSLog("%@", "저수준 이벤트 합성 비활성: 비공개 selector 미발견 — XCUI 경로 사용")
            return nil
        }
        // 비공개 API 시그니처 검증용 — 크래시 시 가정(인자 타입)과 실제를 대조할 근거
        logTypeEncoding(recordClass, "initWithName:interfaceOrientation:")
        logTypeEncoding(pathClass, "initForTouchAtPoint:offset:")
        logTypeEncoding(pathClass, "liftUpAtOffset:")
        logTypeEncoding(recordClass, "addPointerEventPath:")
        if let sessionClass = object_getClass(session) {
            logTypeEncoding(sessionClass, "synthesizeEvent:completion:")
        }
        NSLog("%@", "저수준 이벤트 합성 활성 (WDA 방식 — 스냅샷·interruption 체크 우회)")
        return synthesizer
    }

    private static func logTypeEncoding(_ cls: AnyClass, _ name: String) {
        guard let method = class_getInstanceMethod(cls, NSSelectorFromString(name)),
              let encoding = method_getTypeEncoding(method) else { return }
        NSLog("%@", "합성 API 인코딩 \(name): \(String(cString: encoding))")
    }

    private init?(
        recordClass: AnyClass, pathClass: AnyClass, sessionClass: AnyClass, session: AnyObject
    ) {
        // 클래스 메서드 alloc은 메타클래스에서 해석
        guard let recordMeta = object_getClass(recordClass), let pathMeta = object_getClass(pathClass),
              let alloc = Self.implementation(recordMeta, allocSel, as: AllocFn.self),
              Self.implementation(pathMeta, allocSel, as: AllocFn.self) != nil,
              let initRecord = Self.implementation(recordClass, initRecordSel, as: InitRecordFn.self),
              let initTouch = Self.implementation(pathClass, initTouchSel, as: InitTouchFn.self),
              let move = Self.implementation(pathClass, moveSel, as: MoveFn.self),
              let lift = Self.implementation(pathClass, liftSel, as: LiftFn.self),
              let addPath = Self.implementation(recordClass, addPathSel, as: AddPathFn.self),
              let liveSessionClass = object_getClass(session),
              let synthesize = Self.implementation(liveSessionClass, synthesizeSel, as: SynthesizeFn.self)
        else { return nil }

        self.recordClass = recordClass
        self.pathClass = pathClass
        self.sessionClass = sessionClass
        self.allocFn = alloc
        self.initRecordFn = initRecord
        self.initTouchFn = initTouch
        self.moveFn = move
        self.liftFn = lift
        self.addPathFn = addPath
        self.synthesizeFn = synthesize
    }

    /// 탭 — 성공 시 true, 실패(합성 오류) 시 false → 호출부가 XCUI 폴백
    func tap(x: Double, y: Double) -> Bool {
        let path = makeTouchPath(at: CGPoint(x: x, y: y))
        liftFn(path, liftSel, Self.tapHoldSeconds)
        return run(name: "tap", path: path)
    }

    /// 스와이프 — 시작점 터치 → durationMs에 걸쳐 이동 → 릴리스
    func swipe(fromX: Double, fromY: Double, toX: Double, toY: Double, durationMs: Double) -> Bool {
        let seconds = max(0.05, durationMs / 1000.0)
        let path = makeTouchPath(at: CGPoint(x: fromX, y: fromY))
        moveFn(path, moveSel, CGPoint(x: toX, y: toY), seconds)
        liftFn(path, liftSel, seconds + Self.tapHoldSeconds)
        return run(name: "swipe", path: path)
    }

    // MARK: - 내부

    private static func implementation<T>(_ cls: AnyClass, _ selector: Selector, as type: T.Type) -> T? {
        guard let method = class_getInstanceMethod(cls, selector) else { return nil }
        return unsafeBitCast(method_getImplementation(method), to: T.self)
    }

    /// alloc(+1) → init(+1 소비·반환) → takeRetained로 ARC에 정확히 +1 인계 (누수·과해제 방지)
    private func makeTouchPath(at point: CGPoint) -> AnyObject {
        let allocated = allocFn(pathClass, allocSel).takeUnretainedValue()
        return initTouchFn(allocated, initTouchSel, point, 0).takeRetainedValue()
    }

    private func run(name: String, path: AnyObject) -> Bool {
        let allocated = allocFn(recordClass, allocSel).takeUnretainedValue()
        // orientation 0 = 좌표를 화면 포인트 그대로 사용 (웹이 세로 기준 pt를 보냄)
        let record = initRecordFn(allocated, initRecordSel, name as NSString, 0).takeRetainedValue()
        addPathFn(record, addPathSel, path)
        // 세션은 매번 새로 획득 — 초기화 시점 캐시는 세션 교체 시 죽은 참조가 됨
        guard let sessionUnmanaged = (sessionClass as AnyObject).perform(sharedSessionSel) else {
            NSLog("%@", "이벤트 합성 실패(\(name)): sharedSession 없음 — XCUI 폴백")
            return false
        }
        let session = sessionUnmanaged.takeUnretainedValue()

        // 완료 콜백은 XCTest 데몬 큐에서 옴 — main.sync 안에서 대기해도 교착 없음 (WDA 동일 패턴)
        let semaphore = DispatchSemaphore(value: 0)
        var failure: NSError?
        // 블록 시그니처는 (Bool, NSError?) — 실기기 크래시 리포트로 확정:
        // (NSError?) 1인자로 선언하면 첫 인자 BOOL(0x1)을 objc_retain해 SIGSEGV
        let completion: @convention(block) (Bool, NSError?) -> Void = { _, error in
            failure = error
            semaphore.signal()
        }
        // `as AnyObject`는 블록을 _SwiftValue로 박싱할 수 있어 invoke 시 segfault —
        // unsafeBitCast로 블록 객체 참조를 그대로 전달 (수명은 semaphore 대기가 보장)
        synthesizeFn(session, synthesizeSel, record, unsafeBitCast(completion, to: AnyObject.self))
        let outcome = semaphore.wait(timeout: .now() + Self.completionTimeoutSeconds)
        if outcome == .timedOut {
            // 이벤트가 이미 전달됐을 수 있어 실패 처리(=폴백 재실행) 대신 성공 간주 — 이중 탭 방지
            NSLog("%@", "이벤트 합성 완료 대기 초과(\(name)) — 전달로 간주")
            return true
        }
        if let failure {
            NSLog("%@", "이벤트 합성 실패(\(name)): \(failure.localizedDescription) — XCUI 폴백")
            return false
        }
        return true
    }
}
