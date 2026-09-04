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

/// NWListener 기반 최소 HTTP 서버 — Controller 전용 (keep-alive 없음, 요청당 연결 1개)
/// 보안: usbmuxd(USB) 포워딩 전용이므로 루프백에만 바인딩 — LAN 노출 금지
final class HttpServer {
    /// 본문 크기 상한 — 초과 시 연결 종료
    private static let maxBodyBytes = 1024 * 1024
    /// 요청 수신 제한 시간 — 느린 클라이언트로 인한 리소스 고갈 방지
    private static let readDeadlineSeconds: TimeInterval = 15

    private let listener: NWListener
    private let queue = DispatchQueue(label: "nebula.controller.http")
    private let handler: RouteHandler
    private let onFailure: (String) -> Void

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

            if accumulated.count > Self.maxBodyBytes {
                deadline.cancel()
                connection.cancel()
                return
            }
            if let request = Self.parse(accumulated) {
                deadline.cancel()
                self.respond(connection, request: request)
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
        let payload = (try? JSONSerialization.data(withJSONObject: response.body)) ?? Data("{}".utf8)
        var head = "HTTP/1.1 \(response.status) \(Self.statusText(response.status))\r\n"
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
        return "Error"
    }

    /// 수신 바이트에서 요청 파싱 — 본문이 아직 덜 왔으면 nil
    private static func parse(_ raw: Data) -> HttpRequest? {
        guard let headerEnd = raw.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let headerText = String(data: raw[..<headerEnd.lowerBound], encoding: .utf8) else {
            return nil
        }
        let lines = headerText.components(separatedBy: "\r\n")
        let requestParts = lines[0].components(separatedBy: " ")
        guard requestParts.count >= 2 else { return nil }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            // maxSplits로 안전 분해 — 값 없는 헤더로 인한 인덱스 트랩 방지
            let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { continue }
            headers[parts[0].lowercased().trimmingCharacters(in: .whitespaces)] =
                parts[1].trimmingCharacters(in: .whitespaces)
        }

        let contentLength = headers["content-length"].flatMap(Int.init) ?? 0
        guard contentLength >= 0, contentLength <= maxBodyBytes else { return nil }

        let bodyData = raw[headerEnd.upperBound...]
        guard bodyData.count >= contentLength else { return nil }

        let bodySlice = bodyData.prefix(contentLength)
        let jsonBody =
            (try? JSONSerialization.jsonObject(with: Data(bodySlice))) as? [String: Any] ?? [:]
        return HttpRequest(path: requestParts[1], headers: headers, jsonBody: jsonBody)
    }
}
