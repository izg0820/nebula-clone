import AVFoundation
import CoreMedia
import Foundation
import VideoToolbox

/// 인코딩 해상도 배율 — 네이티브(1290x2796)는 브라우저 디코드가 못 따라가 지연 누적.
/// 절반이면 픽셀 수 1/4, 뷰어 표시 크기(~500px) 기준 화질 손실 없음
private let SCALE_FACTOR = 0.5
/// H.264 인코딩 설정 — 절반 해상도 기준 8Mbps면 픽셀당 비트가 12Mbps 네이티브보다 높음
private let AVERAGE_BITRATE = 8_000_000
/// 키프레임 간격 — 짧을수록 압축 찌꺼기 회복·중간 합류가 빠름 (대역폭 소폭 증가)
private let KEYFRAME_INTERVAL_SECONDS = 1.0
private let EXPECTED_FPS = 60.0
/// 프레임 워치독 — 이 시간 동안 emit 0회면 캡처가 무음 정지한 것으로 보고 종료
/// (프로세스가 살아 있으면 Agent가 재기동하지 않으므로, 크게 실패하고 죽는 것이 복구 경로)
private let FRAME_STALL_EXIT_SECONDS = 15.0
private let WATCHDOG_INTERVAL_SECONDS = 5.0
/// 인코딩 연속 실패 허용 횟수 — 초과 시 종료 (Agent가 재기동)
private let MAX_CONSECUTIVE_ENCODE_FAILURES = 30

/// Annex-B 시작 코드
private let START_CODE = Data([0x00, 0x00, 0x00, 0x01])

enum StreamerError: Error {
    case inputRejected
    case encoderCreationFailed(OSStatus)
}

/// 캡처 장치 → VideoToolbox H.264 → stdout 프레임 스트림
final class DeviceStreamer: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let device: AVCaptureDevice
    private let session = AVCaptureSession()
    private let captureQueue = DispatchQueue(label: "nebula.mirror.capture")
    private let writeQueue = DispatchQueue(label: "nebula.mirror.write")
    private var encoder: VTCompressionSession?
    /// 다운스케일용 (SCALE_FACTOR < 1일 때만 생성)
    private var transferSession: VTPixelTransferSession?
    private var scaledPool: CVPixelBufferPool?
    /// 마지막 프레임 emit 시각 — writeQueue에서만 접근 (워치독도 같은 큐)
    private var lastFrameAt = Date()
    private var watchdog: DispatchSourceTimer?
    /// 인코딩 연속 실패 카운트 — writeQueue에서만 접근
    private var consecutiveEncodeFailures = 0

    init(device: AVCaptureDevice) {
        self.device = device
    }

    func start() throws {
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { throw StreamerError.inputRejected }
        session.addInput(input)

        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: captureQueue)
        guard session.canAddOutput(output) else { throw StreamerError.inputRejected }
        session.addOutput(output)

        observeSilentStops()
        session.startRunning()
        lastFrameAt = Date()
        startWatchdog()
        log("캡처 세션 시작")
    }

    // ── 무음 정지 감지 ───────────────────────────────────
    // 캡처 세션 오류·USB 분리 시 델리게이트 콜백만 조용히 끊긴다 — 프로세스가 살아 있으면
    // Agent가 재기동하지 않으므로, 감지 즉시 크게 실패하고 종료한다 (Agent가 2초 후 재기동)

    private func observeSilentStops() {
        NotificationCenter.default.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil
        ) { notification in
            let error = notification.userInfo?[AVCaptureSessionErrorKey] as? NSError
            log("캡처 세션 런타임 오류: \(error?.localizedDescription ?? "?") — 종료")
            exit(6)
        }
        NotificationCenter.default.addObserver(
            forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: nil
        ) { [weak self] notification in
            guard let self, let disconnected = notification.object as? AVCaptureDevice,
                  disconnected.uniqueID == self.device.uniqueID
            else { return }
            log("캡처 장치 분리됨 (USB 해제 추정) — 종료")
            exit(6)
        }
    }

    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: writeQueue)
        timer.schedule(
            deadline: .now() + WATCHDOG_INTERVAL_SECONDS, repeating: WATCHDOG_INTERVAL_SECONDS)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let stalledSeconds = Date().timeIntervalSince(self.lastFrameAt)
            guard stalledSeconds > FRAME_STALL_EXIT_SECONDS else { return }
            log("프레임 정지 감지 (\(Int(stalledSeconds))초간 emit 없음) — 종료")
            exit(7)
        }
        timer.resume()
        watchdog = timer
    }

    // ── 캡처 콜백 ────────────────────────────────────────

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        if encoder == nil {
            let sourceWidth = CVPixelBufferGetWidth(imageBuffer)
            let sourceHeight = CVPixelBufferGetHeight(imageBuffer)
            // 짝수 정렬 (인코더 요구)
            let targetWidth = Int(Double(sourceWidth) * SCALE_FACTOR) / 2 * 2
            let targetHeight = Int(Double(sourceHeight) * SCALE_FACTOR) / 2 * 2
            do {
                if SCALE_FACTOR < 1.0 {
                    try setupDownscale(
                        targetWidth: targetWidth,
                        targetHeight: targetHeight,
                        pixelFormat: CVPixelBufferGetPixelFormatType(imageBuffer)
                    )
                }
                try setupEncoder(width: targetWidth, height: targetHeight)
                log("인코더 초기화: \(targetWidth)x\(targetHeight) (원본 \(sourceWidth)x\(sourceHeight))")
            } catch {
                log("인코더 생성 실패: \(error)")
                exit(5)
            }
        }

        guard let encoder else { return }
        let inputBuffer = downscaleIfNeeded(imageBuffer)
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let submitStatus = VTCompressionSessionEncodeFrame(
            encoder,
            imageBuffer: inputBuffer,
            presentationTimeStamp: timestamp,
            duration: .invalid,
            frameProperties: nil,
            infoFlagsOut: nil
        ) { [weak self] status, _, encodedBuffer in
            guard let self else { return }
            guard status == noErr, let encodedBuffer else {
                self.recordEncodeFailure(reason: "인코딩 콜백 status=\(status)")
                return
            }
            self.emitFrame(encodedBuffer)
        }
        if submitStatus != noErr {
            recordEncodeFailure(reason: "EncodeFrame 제출 status=\(submitStatus)")
        }
    }

    /// 인코딩 실패 집계 — 무음으로 삼키지 않고 로그, 연속 임계 초과 시 종료 (Agent가 재기동)
    private func recordEncodeFailure(reason: String) {
        writeQueue.async { [weak self] in
            guard let self else { return }
            self.consecutiveEncodeFailures += 1
            if self.consecutiveEncodeFailures == 1 || self.consecutiveEncodeFailures % 10 == 0 {
                log("인코딩 실패 (\(self.consecutiveEncodeFailures)회 연속): \(reason)")
            }
            if self.consecutiveEncodeFailures >= MAX_CONSECUTIVE_ENCODE_FAILURES {
                log("인코딩 연속 실패 임계 초과 — 종료")
                exit(8)
            }
        }
    }

    // ── 다운스케일 ──────────────────────────────────────

    private func setupDownscale(targetWidth: Int, targetHeight: Int, pixelFormat: OSType) throws {
        var newTransfer: VTPixelTransferSession?
        let transferStatus = VTPixelTransferSessionCreate(
            allocator: nil, pixelTransferSessionOut: &newTransfer)
        guard transferStatus == noErr, let created = newTransfer else {
            throw StreamerError.encoderCreationFailed(transferStatus)
        }
        VTSessionSetProperty(
            created, key: kVTPixelTransferPropertyKey_ScalingMode,
            value: kVTScalingMode_Trim)
        transferSession = created

        let poolAttributes: [CFString: Any] = [
            kCVPixelBufferWidthKey: targetWidth,
            kCVPixelBufferHeightKey: targetHeight,
            kCVPixelBufferPixelFormatTypeKey: pixelFormat,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        var newPool: CVPixelBufferPool?
        let poolStatus = CVPixelBufferPoolCreate(
            nil, nil, poolAttributes as CFDictionary, &newPool)
        guard poolStatus == kCVReturnSuccess, let pool = newPool else {
            throw StreamerError.encoderCreationFailed(poolStatus)
        }
        scaledPool = pool
    }

    /// 다운스케일 활성 시 축소 버퍼 반환, 실패·비활성 시 원본 그대로
    private func downscaleIfNeeded(_ source: CVImageBuffer) -> CVImageBuffer {
        guard let transferSession, let scaledPool else { return source }
        var scaled: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, scaledPool, &scaled) == kCVReturnSuccess,
              let target = scaled
        else { return source }
        guard VTPixelTransferSessionTransferImage(transferSession, from: source, to: target) == noErr
        else { return source }
        return target
    }

    // ── 인코더 ──────────────────────────────────────────

    private func setupEncoder(width: Int, height: Int) throws {
        var newSession: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &newSession
        )
        guard status == noErr, let created = newSession else {
            throw StreamerError.encoderCreationFailed(status)
        }

        // 저지연 실시간 스트림: B-프레임 금지(WebCodecs 순차 디코딩), 2초 키프레임(중간 합류)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Main_AutoLevel)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AverageBitRate, value: AVERAGE_BITRATE as CFNumber)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: KEYFRAME_INTERVAL_SECONDS as CFNumber)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: EXPECTED_FPS as CFNumber)
        // 지연 최소화 — 인코더 내부 프레임 홀드 금지 + 속도 우선
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: 1 as CFNumber)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, value: kCFBooleanTrue)
        VTCompressionSessionPrepareToEncodeFrames(created)
        encoder = created
    }

    // ── 프레임 출력 ──────────────────────────────────────

    /// 인코딩된 샘플 → [len][isKey][Annex-B] 패킷으로 stdout 출력
    private func emitFrame(_ sampleBuffer: CMSampleBuffer) {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        let isKeyframe = !isNotSync(sampleBuffer)
        var payload = Data()

        // 키프레임엔 SPS/PPS 선행 — 중간 합류 시청자의 디코더 초기화
        if isKeyframe, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
            appendParameterSets(from: format, to: &payload)
        }
        appendAnnexB(from: dataBuffer, to: &payload)
        guard !payload.isEmpty else { return }

        var packet = Data(capacity: payload.count + 5)
        var lengthBE = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &lengthBE) { packet.append(contentsOf: $0) }
        packet.append(isKeyframe ? 1 : 0)
        packet.append(payload)

        writeQueue.sync {
            FileHandle.standardOutput.write(packet)
            lastFrameAt = Date()
            consecutiveEncodeFailures = 0
        }
    }

    private func isNotSync(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[CFString: Any]],
            let first = attachments.first
        else { return false }
        return first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
    }

    /// SPS/PPS를 Annex-B로 추가
    private func appendParameterSets(from format: CMFormatDescription, to payload: inout Data) {
        var parameterSetCount = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0, parameterSetPointerOut: nil,
            parameterSetSizeOut: nil, parameterSetCountOut: &parameterSetCount, nalUnitHeaderLengthOut: nil
        )
        for index in 0..<parameterSetCount {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format, parameterSetIndex: index, parameterSetPointerOut: &pointer,
                parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil
            )
            guard status == noErr, let pointer else { continue }
            payload.append(START_CODE)
            payload.append(pointer, count: size)
        }
    }

    /// AVCC(4바이트 길이 프리픽스) → Annex-B 변환
    private func appendAnnexB(from dataBuffer: CMBlockBuffer, to payload: inout Data) {
        var totalLength = 0
        var rawPointer: UnsafeMutablePointer<CChar>?
        let status = CMBlockBufferGetDataPointer(
            dataBuffer, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength, dataPointerOut: &rawPointer
        )
        guard status == noErr, let rawPointer else { return }

        var offset = 0
        while offset + 4 <= totalLength {
            var nalLength: UInt32 = 0
            memcpy(&nalLength, rawPointer + offset, 4)
            nalLength = UInt32(bigEndian: nalLength)
            offset += 4
            guard offset + Int(nalLength) <= totalLength else { break }

            payload.append(START_CODE)
            rawPointer.withMemoryRebound(to: UInt8.self, capacity: totalLength) { bytes in
                payload.append(bytes + offset, count: Int(nalLength))
            }
            offset += Int(nalLength)
        }
    }
}
