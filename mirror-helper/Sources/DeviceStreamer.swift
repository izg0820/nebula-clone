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

        session.startRunning()
        log("캡처 세션 시작")
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
        VTCompressionSessionEncodeFrame(
            encoder,
            imageBuffer: inputBuffer,
            presentationTimeStamp: timestamp,
            duration: .invalid,
            frameProperties: nil,
            infoFlagsOut: nil
        ) { [weak self] status, _, encodedBuffer in
            guard status == noErr, let encodedBuffer, let self else { return }
            self.emitFrame(encodedBuffer)
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
