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
///   mirror-helper --name <기기이름>   # 해당 기기 스트림 시작 (미지정 시 첫 muxed 장치)
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

/// 현재 발행된 iOS 화면 캡처 장치들 (muxed) — macOS 26에서 DiscoverySession에 미노출되므로
/// CMIO 저수준 열거 → UID → AVCaptureDevice(uniqueID:) 직접 생성으로 우회
func muxedCaptureDevices() -> [AVCaptureDevice] {
    var address = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    var dataSize: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, &dataSize) == 0 else {
        return []
    }
    let count = Int(dataSize) / MemoryLayout<CMIOObjectID>.size
    var ids = [CMIOObjectID](repeating: 0, count: count)
    var used: UInt32 = 0
    guard CMIOObjectGetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, dataSize, &used, &ids) == 0 else {
        return []
    }

    var devices: [AVCaptureDevice] = []
    for objectId in ids {
        guard let uid = cmioStringProperty(objectId, selector: CMIOObjectPropertySelector(kCMIODevicePropertyDeviceUID)) else { continue }
        guard let device = AVCaptureDevice(uniqueID: uid) else { continue }
        if device.hasMediaType(.muxed) { devices.append(device) }
    }
    return devices
}

/// iOS 화면 캡처 장치 검색 — 발행에 수십 초 걸릴 수 있어 재시도
/// name: 다중 기기 구분용 기기 이름 (devicectl의 deviceProperties.name) — 미지정 시 첫 장치
func findDevice(name: String?, timeoutSeconds: Int) -> AVCaptureDevice? {
    let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
    while Date() < deadline {
        let devices = muxedCaptureDevices()
        if let name {
            if let match = devices.first(where: { $0.localizedName == name }) { return match }
        }
        if name == nil, let first = devices.first { return first }
        RunLoop.main.run(until: Date().addingTimeInterval(1.0))
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
        let name = cmioStringProperty(deviceId, selector: CMIOObjectPropertySelector(kCMIOObjectPropertyName)) ?? "?"
        let uid = cmioStringProperty(deviceId, selector: CMIOObjectPropertySelector(kCMIODevicePropertyDeviceUID)) ?? "?"
        print("CMIO #\(deviceId): \(name)\tUID=\(uid)")

        // AVFoundation 직접 생성 시도 — DiscoverySession 미노출 장치 우회
        if let direct = AVCaptureDevice(uniqueID: uid) {
            print("  → AVCaptureDevice(uniqueID:) 성공: \(direct.localizedName), muxed=\(direct.hasMediaType(.muxed))")
        }
    }
}

/// CMIO 문자열 속성 조회
func cmioStringProperty(_ objectId: CMIOObjectID, selector: CMIOObjectPropertySelector) -> String? {
    var address = CMIOObjectPropertyAddress(
        mSelector: selector,
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    var size: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(objectId, &address, 0, nil, &size) == 0 else { return nil }
    var value: CFString = "" as CFString
    var used: UInt32 = 0
    guard CMIOObjectGetPropertyData(objectId, &address, 0, nil, size, &used, &value) == 0 else { return nil }
    return value as String
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

/// --name <기기이름> (다중 기기 구분, devicectl의 name) — 미지정 시 첫 muxed 장치
func argumentValue(_ flag: String) -> String? {
    guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

// 플래그는 있는데 값이 없으면 "첫 장치"로 조용히 넘어가 다른 기기를 스트리밍할 수 있음 — 즉시 실패
if arguments.contains("--name"), argumentValue("--name") == nil {
    log("--name 플래그에 기기 이름이 없음 — 사용법: mirror-helper --name <기기이름>")
    exit(2)
}
let deviceName = argumentValue("--name")

// 데몬 환경이라 권한 프롬프트에 응답할 GUI가 없음 — 미허용이면 명시적으로 실패
// (미확인 시 캡처 세션은 "시작"까지 성공하고 프레임만 안 오는 무음 프리즈가 됨)
let cameraStatus = AVCaptureDevice.authorizationStatus(for: .video)
if cameraStatus != .authorized {
    log("카메라 권한 없음 (status=\(cameraStatus.rawValue)) — 시스템 설정에서 허용 후 재실행")
    exit(2)
}

enableScreenCaptureDevices()
log("기기 검색 중: \(deviceName ?? "(첫 번째 muxed 장치)")")
guard let device = findDevice(name: deviceName, timeoutSeconds: 60) else {
    log("기기를 캡처 장치로 찾지 못함: \(deviceName ?? "?")")
    exit(3)
}
log("캡처 장치 발견: \(device.localizedName) (\(device.uniqueID))")

let streamer = DeviceStreamer(device: device)

// 시그널 핸들러에서 exit()는 async-signal-safe가 아님 (atexit·stdio 플러시 중 데드락 가능)
signal(SIGTERM) { _ in _exit(0) }
signal(SIGINT) { _ in _exit(0) }

do {
    try streamer.start()
} catch {
    log("스트림 시작 실패: \(error)")
    exit(4)
}

// 캡처 델리게이트·인코더 콜백이 백그라운드 큐에서 동작 — 메인 런루프 유지
RunLoop.main.run()
