# mirror-helper — iOS 화면 → H.264 스트림 (원문 방식, macOS 26 동작 확인)

USB 연결된 iPhone을 macOS 화면 캡처 장치(CoreMediaIO)로 열어 VideoToolbox H.264로 인코딩,
stdout으로 프레임 스트림을 출력하는 Swift CLI. **실기기 검증 완료 (2026-09-07): 40fps, 8KB/frame.**
Agent가 `NEBULA_MIRROR_HELPER`로 기기당 1프로세스를 스폰한다 (미지정 시 미러링 비활성 — H.264 단독).

## macOS 26에서의 함정 두 개 (실측으로 확인)

1. **AVCaptureDevice.DiscoverySession에 iOS 캡처 장치가 안 보인다** — CMIO 저수준
   열거(`kCMIOHardwarePropertyDevices`)로 UID를 얻어 `AVCaptureDevice(uniqueID:)`로 직접
   열어야 한다. 이 코드는 그렇게 구현돼 있다.
2. **장치 발행 트리거**: 우리의 `AllowScreenCaptureDevices` 속성 설정만으로는 즉시 발행되지
   않았고, QuickTime의 녹화 소스 열람이 최초 발행을 트리거했다. 발행 후에는 QuickTime을
   종료해도 유지됨. ⚠ **콜드 스타트(USB 재연결·재부팅 후) 자가 발행 여부 미검증** — 안 되면
   `osascript`로 QuickTime을 잠깐 열었다 닫는 활성화 킥이 필요할 수 있다 (수퍼바이저 백로그).

## 프레임 형식 (stdout)

```
[UInt32 BE payload 길이][UInt8 키프레임(1/0)][Annex-B H.264 access unit]
```
키프레임 앞에는 SPS/PPS 포함 (중간 합류 시청자 디코더 초기화). 키프레임 간격 1초, B-프레임 없음.
stderr의 `인코더 초기화: WxH` 로그는 Agent가 파싱하는 계약 — 문구를 바꾸면 프레임이 폐기됨.
캡처 중단(USB 분리·세션 오류)·15초 프레임 정지·인코딩 연속 실패 시 스스로 종료한다 (Agent가 재기동).

## 사용

```bash
swift build                                   # 배포는 -c release 권장
./.build/debug/mirror-helper --list           # AVFoundation 열거 진단
./.build/debug/mirror-helper --list-cmio      # CMIO 저수준 열거 (UID 확인)
./.build/debug/mirror-helper --name wincrane2 # 기기 이름으로 스트림 시작
```

`--name`은 devicectl의 기기 이름과 일치해야 한다 (다중 기기 구분). 카메라 권한(TCC) 필요 —
최초 실행 시 허용.

## 다중 기기

기기마다 독립된 캡처 장치가 발행되므로 기기당 헬퍼 1프로세스로 확장된다.
USB 대역폭이 병목이 될 수 있으니 허브 구성에 유의 (원문의 "USB 케이블·허브 선정 기준").
