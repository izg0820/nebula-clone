import AVFoundation
import CoreMediaIO
import Foundation

/// Nebula 미러링 헬퍼 — USB 연결된 iPhone 화면을 H.264 스트림으로 stdout에 출력
///
/// 원리: macOS는 USB 연결된 iOS 기기를 화면 캡처 장치(CoreMediaIO DAL)로 노출할 수 있다
/// (QuickTime 동영상 녹화가 쓰는 것과 같은 메커니즘). 이 장치는 XCUITest 조작 세션과
/// 독립적이라 "보면서 동시에 조작"이 가능하다 — 원문 Nebula의 해법.
///
/// 사용:
///   mirror-helper --list             # 캡처 가능한 iOS 기기 나열
///   mirror-helper --udid <UDID>      # 해당 기기 스트림 시작
///
/// 출력 프레임 형식 (stdout, 바이너리):
///   [UInt32 BE payload 길이][UInt8 키프레임 여부(1/0)][Annex-B H.264 access unit]
///   키프레임 앞에는 SPS/PPS가 포함됨 (스트림 중간 합류 시청자의 디코더 초기화용)

/// 로그는 전부 stderr — stdout은 스트림 전용
func log(_ message: String) {
    FileHandle.standardError.write(Data("[mirror-helper] \(message)\n".utf8))
}

/// iOS 기기를 캡처 장치로 노출하도록 CoreMediaIO 전역 속성 활성화
func enableScreenCaptureDevices() {
    var property = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    var allow: UInt32 = 1
    let result = CMIOObjectSetPropertyData(
        CMIOObjectID(kCMIOObjectSystemObject), &property, 0, nil,
        UInt32(MemoryLayout<UInt32>.size), &allow
    )
    if result != 0 {
        log("경고: 캡처 장치 활성화 실패 (CMIO status \(result))")
    }

    // 무선 화면 캡처 장치도 함께 허용 (macOS 버전에 따라 USB 발행에 영향 가능성 — 진단 겸)
    var wirelessProperty = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowWirelessScreenCaptureDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    var allowWireless: UInt32 = 1
    _ = CMIOObjectSetPropertyData(
        CMIOObjectID(kCMIOObjectSystemObject), &wirelessProperty, 0, nil,
        UInt32(MemoryLayout<UInt32>.size), &allowWireless
    )
}

/// iOS 화면 캡처 장치 검색 — 활성화 직후엔 장치 등록에 수 초 걸릴 수 있어 재시도
func findDevice(udid: String?, timeoutSeconds: Int) -> AVCaptureDevice? {
    let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
    while Date() < deadline {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external],
            mediaType: .muxed,
            position: .unspecified
        )
        let devices = discovery.devices
        if let udid {
            // iOS 캡처 장치의 uniqueID는 UDID (하이픈 유무 변형 대비 정규화 비교)
            let normalized = udid.replacingOccurrences(of: "-", with: "").lowercased()
            let match = devices.first {
                $0.uniqueID.replacingOccurrences(of: "-", with: "").lowercased() == normalized
            }
            if let match { return match }
        }
        if udid == nil && !devices.isEmpty { return devices.first }
        Thread.sleep(forTimeInterval: 1.0)
    }
    return nil
}

/// 카메라 권한 확인·요청 — DAL 캡처 장치 접근에 필요
func ensureCameraAccess() {
    let status = AVCaptureDevice.authorizationStatus(for: .video)
    log("카메라 권한 상태: \(status.rawValue) (0=미결정 1=제한 2=거부 3=허용)")
    if status == .authorized { return }

    let semaphore = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .video) { granted in
        log("카메라 권한 요청 결과: \(granted)")
        semaphore.signal()
    }
    semaphore.wait()
}

func listDevices() {
    enableScreenCaptureDevices()
    ensureCameraAccess()

    // 장치 연결 알림 구독 — 등록 시점 관측
    NotificationCenter.default.addObserver(
        forName: AVCaptureDevice.wasConnectedNotification, object: nil, queue: nil
    ) { notification in
        let device = notification.object as? AVCaptureDevice
        log("장치 연결됨: \(device?.localizedName ?? "?") (\(device?.uniqueID ?? "?"))")
    }
    // DAL 장치 등록은 런루프 처리 필요 + USB 재구성에 수십 초 걸릴 수 있어 반복 열거
    for second in 1...30 {
        RunLoop.main.run(until: Date().addingTimeInterval(1.0))
        let probe = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external], mediaType: nil, position: .unspecified)
        if !probe.devices.isEmpty {
            log("외장 장치 등장 (t=\(second)s)")
            break
        }
    }

    // 진단: 타입 제한 없이 전체 외장 장치 나열
    let discovery = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.external, .microphone, .builtInWideAngleCamera],
        mediaType: nil,
        position: .unspecified
    )
    log("발견된 장치 수: \(discovery.devices.count)")
    for device in discovery.devices {
        let mediaTypes = [AVMediaType.muxed, .video].filter { device.hasMediaType($0) }
        print("\(device.uniqueID)\t\(device.localizedName)\t\(device.deviceType.rawValue)\t\(mediaTypes)")
    }
    if discovery.devices.isEmpty {
        log("캡처 가능한 기기 없음 (USB 연결·잠금 해제 확인)")
    }
}

/// CMIO 장치를 저수준으로 직접 열거 — AVFoundation 브리징 문제 진단용
func listCmioDevices() {
    enableScreenCaptureDevices()
    RunLoop.main.run(until: Date().addingTimeInterval(5.0))

    var address = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    var dataSize: UInt32 = 0
    var result = CMIOObjectGetPropertyDataSize(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, &dataSize)
    guard result == 0 else {
        log("CMIO 장치 목록 크기 조회 실패: \(result)")
        return
    }
    let deviceCount = Int(dataSize) / MemoryLayout<CMIOObjectID>.size
    var deviceIds = [CMIOObjectID](repeating: 0, count: deviceCount)
    var dataUsed: UInt32 = 0
    result = CMIOObjectGetPropertyData(
        CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, dataSize, &dataUsed, &deviceIds)
    guard result == 0 else {
        log("CMIO 장치 목록 조회 실패: \(result)")
        return
    }
    log("CMIO 장치 수: \(deviceCount)")

    for deviceId in deviceIds {
        var nameAddress = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIOObjectPropertyName),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
        )
        var nameSize: UInt32 = 0
        guard CMIOObjectGetPropertyDataSize(deviceId, &nameAddress, 0, nil, &nameSize) == 0 else { continue }
        var name: CFString = "" as CFString
        var used: UInt32 = 0
        guard CMIOObjectGetPropertyData(deviceId, &nameAddress, 0, nil, nameSize, &used, &name) == 0 else { continue }
        print("CMIO #\(deviceId): \(name)")
    }
}

// ── 엔트리 ──────────────────────────────────────────────

let arguments = CommandLine.arguments

if arguments.contains("--list") {
    listDevices()
    exit(0)
}

if arguments.contains("--list-cmio") {
    listCmioDevices()
    exit(0)
}

guard let udidIndex = arguments.firstIndex(of: "--udid"), udidIndex + 1 < arguments.count else {
    log("사용법: mirror-helper --list | --udid <UDID>")
    exit(2)
}
let udid = arguments[udidIndex + 1]

enableScreenCaptureDevices()
log("기기 검색 중: \(udid)")
guard let device = findDevice(udid: udid, timeoutSeconds: 30) else {
    log("기기를 캡처 장치로 찾지 못함: \(udid)")
    exit(3)
}
log("캡처 장치 발견: \(device.localizedName) (\(device.uniqueID))")

let streamer = DeviceStreamer(device: device)

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

do {
    try streamer.start()
} catch {
    log("스트림 시작 실패: \(error)")
    exit(4)
}

// 캡처 델리게이트·인코더 콜백이 백그라운드 큐에서 동작 — 메인 런루프 유지
RunLoop.main.run()
