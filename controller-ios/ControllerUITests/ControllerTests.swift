import XCTest

/// Nebula Controller — "끝나지 않는 테스트"로 HTTP 서버를 상시 호스팅 (WebDriverAgent 방식)
/// 기동: xcodebuild test -project NebulaController.xcodeproj -scheme NebulaController \
///        -destination 'id=<UDID>' -allowProvisioningUpdates
/// 환경: TEST_RUNNER_NEBULA_CONTROLLER_PORT (기본 8100),
///        TEST_RUNNER_NEBULA_CONTROLLER_TOKEN (설정 시 x-nebula-token 헤더 검증)
final class ControllerTests: XCTestCase {
    private static let defaultPort: UInt16 = 8100
    /// 좌표 상한 — 서버 DTO와 동일 기준 (화면 밖 좌표로 러너가 죽는 것 방지)
    private static let maxCoordinate: Double = 10_000
    private static let maxTextLength = 4_000
    /// 스와이프 상한 — Agent HTTP 타임아웃(10초)보다 낮게 (서버 DTO는 5초로 더 엄격)
    private static let maxSwipeDurationMs: Double = 8_000

    func testRunControllerServer() throws {
        disableQuiescenceWaits()
        let actions = ActionHandler()
        let environment = ProcessInfo.processInfo.environment
        let port = environment["NEBULA_CONTROLLER_PORT"].flatMap(UInt16.init) ?? Self.defaultPort
        // 빈 문자열 토큰은 미설정 취급 — "비워서 끄기" 습관이 전면 401 락아웃이 되지 않게
        var token: String?
        if let rawToken = environment["NEBULA_CONTROLLER_TOKEN"]?
            .trimmingCharacters(in: .whitespaces), !rawToken.isEmpty {
            token = rawToken
        }

        // 서버 치명 실패 시 fulfill — 대기가 풀려 테스트(러너 프로세스)가 실제로 끝남.
        // XCTFail만으로는 기록만 되고 1년 대기가 계속 돌아 리스너 없는 유령 러너가 남음
        let serverFatal = XCTestExpectation(description: "controller server fatal failure")
        let server = try HttpServer(
            port: port,
            handler: { request in
                Self.route(request: request, token: token, actions: actions)
            },
            onFailure: { message in
                XCTFail("HTTP 서버 실패: \(message)")
                serverFatal.fulfill()
            }
        )
        server.start()

        // 러너를 살아있게 유지 — 서버가 치명 실패할 때까지 무기한 대기
        let oneYearSeconds: TimeInterval = 60 * 60 * 24 * 365
        _ = XCTWaiter.wait(for: [serverFatal], timeout: oneYearSeconds)
    }

    /// 경로 라우팅 — Agent의 ControllerClient와 계약 일치 필수
    private static func route(
        request: HttpRequest, token: String?, actions: ActionHandler
    ) -> HttpResponse {
        if let token, request.headers["x-nebula-token"] != token {
            return HttpResponse(status: 401, body: ["ok": false, "error": "unauthorized"])
        }
        if request.path == "/health" {
            return HttpResponse(status: 200, body: ["status": "ok"])
        }

        // XCUI 조작은 메인 스레드에서 실행
        // (전제: XCTWaiter.wait가 메인 런루프를 돌려 main.sync가 드레인됨 — WDA와 동일 패턴, 실기기 검증 필요)
        return DispatchQueue.main.sync {
            routeAction(path: request.path, body: request.jsonBody, actions: actions)
        }
    }

    private static func routeAction(
        path: String, body: [String: Any], actions: ActionHandler
    ) -> HttpResponse {
        if path == "/tap" {
            guard let x = coordinate(body["x"]), let y = coordinate(body["y"]) else {
                return badRequest("x·y는 0~\(Int(maxCoordinate)) 범위 숫자")
            }
            actions.tap(x: x, y: y)
            return HttpResponse(status: 200, body: ["ok": true])
        }
        if path == "/swipe" {
            guard let fromX = coordinate(body["fromX"]), let fromY = coordinate(body["fromY"]),
                  let toX = coordinate(body["toX"]), let toY = coordinate(body["toY"]) else {
                return badRequest("fromX/fromY/toX/toY는 0~\(Int(maxCoordinate)) 범위 숫자")
            }
            let durationMs = body["durationMs"] as? Double ?? 300
            // 러너 측 상한 — 과도한 드래그가 직렬 큐(/health 포함)를 장시간 막는 것 방지
            guard durationMs > 0, durationMs <= maxSwipeDurationMs else {
                return badRequest("durationMs는 1~\(Int(maxSwipeDurationMs)) 범위")
            }
            actions.swipe(fromX: fromX, fromY: fromY, toX: toX, toY: toY, durationMs: durationMs)
            return HttpResponse(status: 200, body: ["ok": true])
        }
        if path == "/type" {
            guard let text = body["text"] as? String, text.count <= maxTextLength else {
                return badRequest("text는 \(maxTextLength)자 이하 문자열")
            }
            actions.typeText(text)
            return HttpResponse(status: 200, body: ["ok": true])
        }
        if path == "/ui" {
            let bundleId = body["bundleId"] as? String
            return HttpResponse(status: 200, body: ["ok": true, "tree": actions.uiDump(bundleId: bundleId)])
        }
        if path == "/press" {
            guard let button = body["button"] as? String, button == "home" else {
                return badRequest("button은 'home'만 지원")
            }
            actions.pressHome()
            return HttpResponse(status: 200, body: ["ok": true])
        }
        if path == "/screenshot" {
            guard let result = actions.screenshot() else {
                return HttpResponse(status: 500, body: ["ok": false, "error": "capture 실패"])
            }
            return HttpResponse(status: 200, body: [
                "ok": true,
                "jpegBase64": result.jpegBase64,
                "widthPt": result.widthPt,
                "heightPt": result.heightPt,
            ])
        }
        return HttpResponse(status: 404, body: ["ok": false, "error": "unknown path \(path)"])
    }

    /// 좌표 검증 — 범위 밖·비숫자는 nil
    private static func coordinate(_ raw: Any?) -> Double? {
        guard let value = raw as? Double, value >= 0, value <= maxCoordinate else { return nil }
        return value
    }

    private static func badRequest(_ message: String) -> HttpResponse {
        return HttpResponse(status: 400, body: ["ok": false, "error": message])
    }
}
