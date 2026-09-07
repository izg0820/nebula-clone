import Foundation
import Network

/// 요청 라우팅 결과
struct HttpResponse {
    let status: Int
    let body: [String: Any]
}

/// 파싱된 요청 — 라우팅에 필요한 최소 정보
struct HttpRequest {
    let path: String
    let headers: [String: String]
    let jsonBody: [String: Any]
}

/// 요청 → 응답 핸들러
typealias RouteHandler = (_ request: HttpRequest) -> HttpResponse

/// 수신 버퍼 파싱 결과 — 이상 요청에 무응답 대신 상태 코드를 돌려주기 위한 3상태
enum HttpParseResult {
    case needMore
    case bad(status: Int, reason: String)
    case ok(HttpRequest)
}

/// NWListener 기반 최소 HTTP 서버 — Controller 전용 (keep-alive 없음, 요청당 연결 1개)
/// 보안: usbmuxd(USB) 포워딩 전용이므로 루프백에만 바인딩 — LAN 노출 금지
final class HttpServer {
    /// 본문 크기 상한 — 초과 시 413 응답 후 종료
    private static let maxBodyBytes = 1024 * 1024
    /// 요청 수신 제한 시간 — 느린 클라이언트로 인한 리소스 고갈 방지
    private static let readDeadlineSeconds: TimeInterval = 15
    /// 동시 연결 상한 — 연결당 버퍼·타이머를 잡으므로 무제한 수용 금지
    private static let maxConcurrentConnections = 16

    private let listener: NWListener
    private let queue = DispatchQueue(label: "nebula.controller.http")
    private let handler: RouteHandler
    private let onFailure: (String) -> Void
    /// 활성 연결 수 — queue에서만 접근
    private var activeConnections = 0

    init(port: UInt16, handler: @escaping RouteHandler, onFailure: @escaping (String) -> Void) throws {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(domain: "nebula.controller", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "잘못된 포트: \(port)"])
        }
        let parameters = NWParameters.tcp
        // 루프백 전용 바인딩 — 같은 Wi-Fi의 다른 호스트가 기기를 조작하는 경로 차단
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: nwPort)

        self.handler = handler
        self.onFailure = onFailure
        self.listener = try NWListener(using: parameters)
    }

    func start() {
        listener.stateUpdateHandler = { [weak self] state in
            // 포트 점유 등 리스너 실패를 조용히 삼키지 않음 — 러너를 즉시 실패시켜 관측 가능하게
            if case .failed(let error) = state {
                self?.onFailure("listener 실패: \(error)")
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
    }

    private func accept(_ connection: NWConnection) {
        if activeConnections >= Self.maxConcurrentConnections {
            connection.cancel()
            return
        }
        activeConnections += 1
        // 종료 시 카운트 반납 — failed·cancelled 중복 방출 대비 1회만
        var isReleased = false
        connection.stateUpdateHandler = { [weak self] state in
            let release = {
                guard !isReleased else { return }
                isReleased = true
                self?.activeConnections -= 1
            }
            if case .cancelled = state { release() }
            if case .failed = state { release() }
        }
        connection.start(queue: queue)

        // 수신 제한 시간 — 본문을 안 보내고 버티는 연결 정리
        let deadline = DispatchWorkItem { connection.cancel() }
        queue.asyncAfter(deadline: .now() + Self.readDeadlineSeconds, execute: deadline)

        receiveRequest(connection, buffer: Data(), deadline: deadline)
    }

    /// 헤더 종료(\r\n\r\n)까지 수신 후 Content-Length만큼 본문 확보
    private func receiveRequest(_ connection: NWConnection, buffer: Data, deadline: DispatchWorkItem) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self] data, _, isComplete, error in
            guard let self, error == nil, let data else {
                deadline.cancel()
                connection.cancel()
                return
            }
            var accumulated = buffer
            accumulated.append(data)

            if accumulated.count > Self.maxBodyBytes + 64 * 1024 {
                deadline.cancel()
                self.sendResponse(connection, status: 413, body: ["ok": false, "error": "요청 크기 초과"])
                return
            }
            let result = Self.parse(accumulated)
            if case .ok(let request) = result {
                deadline.cancel()
                self.respond(connection, request: request)
                return
            }
            if case .bad(let status, let reason) = result {
                // 무응답 종료 대신 원인 있는 상태 코드 — 클라이언트가 커넥션 리셋만 보지 않게
                deadline.cancel()
                self.sendResponse(connection, status: status, body: ["ok": false, "error": reason])
                return
            }
            if isComplete {
                deadline.cancel()
                connection.cancel()
                return
            }
            self.receiveRequest(connection, buffer: accumulated, deadline: deadline)
        }
    }

    private func respond(_ connection: NWConnection, request: HttpRequest) {
        let response = handler(request)
        sendResponse(connection, status: response.status, body: response.body)
    }

    private func sendResponse(_ connection: NWConnection, status: Int, body: [String: Any]) {
        var effectiveStatus = status
        var payload: Data
        if let serialized = try? JSONSerialization.data(withJSONObject: body) {
            payload = serialized
        } else {
            // 직렬화 실패를 200 + {}로 은폐하지 않음 — 실패는 실패로 전파
            NSLog("[nebula-controller] 응답 직렬화 실패 (status=%d)", status)
            effectiveStatus = 500
            payload = Data("{\"ok\":false,\"error\":\"응답 직렬화 실패\"}".utf8)
        }
        var head = "HTTP/1.1 \(effectiveStatus) \(Self.statusText(effectiveStatus))\r\n"
        head += "Content-Type: application/json\r\n"
        head += "Content-Length: \(payload.count)\r\n"
        head += "Connection: close\r\n\r\n"

        var out = Data(head.utf8)
        out.append(payload)
        connection.send(content: out, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func statusText(_ status: Int) -> String {
        if status == 200 { return "OK" }
        if status == 400 { return "Bad Request" }
        if status == 401 { return "Unauthorized" }
        if status == 404 { return "Not Found" }
        if status == 413 { return "Payload Too Large" }
        if status == 500 { return "Internal Server Error" }
        if status == 501 { return "Not Implemented" }
        return "Error"
    }

    /// 수신 바이트에서 요청 파싱 — 본문이 덜 왔으면 needMore, 이상 요청은 bad(status)
    private static func parse(_ raw: Data) -> HttpParseResult {
        guard let headerEnd = raw.range(of: Data("\r\n\r\n".utf8)) else { return .needMore }
        guard let headerText = String(data: raw[..<headerEnd.lowerBound], encoding: .utf8) else {
            return .bad(status: 400, reason: "헤더 인코딩 오류")
        }
        let lines = headerText.components(separatedBy: "\r\n")
        let requestParts = lines[0].components(separatedBy: " ")
        guard requestParts.count >= 2 else { return .bad(status: 400, reason: "요청 라인 형식 오류") }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            // maxSplits로 안전 분해 — 값 없는 헤더로 인한 인덱스 트랩 방지
            let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { continue }
            headers[parts[0].lowercased().trimmingCharacters(in: .whitespaces)] =
                parts[1].trimmingCharacters(in: .whitespaces)
        }

        // chunked 미지원 — Content-Length만 기다리다 데드라인 무응답으로 끝나지 않게 명시 거부
        if headers["transfer-encoding"] != nil {
            return .bad(status: 501, reason: "Transfer-Encoding 미지원 (Content-Length 사용)")
        }
        guard let contentLength = parseContentLength(headers["content-length"]) else {
            return .bad(status: 400, reason: "Content-Length 형식 오류")
        }
        guard contentLength <= maxBodyBytes else {
            return .bad(status: 413, reason: "본문 크기 초과")
        }

        let bodyData = raw[headerEnd.upperBound...]
        guard bodyData.count >= contentLength else { return .needMore }

        let bodySlice = bodyData.prefix(contentLength)
        let jsonBody =
            (try? JSONSerialization.jsonObject(with: Data(bodySlice))) as? [String: Any] ?? [:]
        return .ok(HttpRequest(path: requestParts[1], headers: headers, jsonBody: jsonBody))
    }

    /// Content-Length 파싱 — 헤더 없음은 0(본문 없음), 비정수·음수는 nil(400)
    private static func parseContentLength(_ rawValue: String?) -> Int? {
        guard let rawValue else { return 0 }
        guard let parsed = Int(rawValue), parsed >= 0 else { return nil }
        return parsed
    }
}
