# iOS 미러링 헬퍼

USB 연결된 iPhone을 macOS 화면 캡처 장치(CoreMediaIO)로 열어 VideoToolbox H.264로 인코딩,
stdout으로 프레임 스트림을 출력하는 Swift CLI입니다.
Agent는 기본적으로 저장소의 `mirror-helper/.build/debug/mirror-helper`를 사용하며, `NEBULA_MIRROR_HELPER`로 경로를 변경할 수 있습니다.
전체 스택 실행은 [루트 README](../README.md)를 참고하세요.

## macOS 26에서 장치가 보이지 않을 때

1. **AVCaptureDevice.DiscoverySession에 iOS 캡처 장치가 안 보인다** — CMIO 저수준
   열거(`kCMIOHardwarePropertyDevices`)로 UID를 얻어 `AVCaptureDevice(uniqueID:)`로 직접
   열어야 한다. 이 코드는 그렇게 구현돼 있다.
2. **장치 발행 트리거**: 우리의 `AllowScreenCaptureDevices` 속성 설정만으로는 즉시 발행되지
   않았고, QuickTime의 녹화 소스 열람이 최초 발행을 트리거했다. 발행 후에는 QuickTime을
   종료해도 유지됨. ⚠ **콜드 스타트(USB 재연결·재부팅 후) 자가 발행 여부 미검증** — 안 되면
   QuickTime의 동영상 녹화 소스 목록을 다시 열어 장치 인식을 확인하세요.

## 프레임 형식 (stdout)

```
[UInt32 BE payload 길이][UInt8 키프레임(1/0)][Annex-B H.264 access unit]
```
키프레임 앞에는 SPS/PPS 포함 (중간 합류 시청자 디코더 초기화). 키프레임 간격 1초, B-프레임 없음.
stderr의 `인코더 초기화: WxH` 로그는 Agent가 파싱하는 계약 — 문구를 바꾸면 프레임이 폐기됨.
캡처 중단(USB 분리·세션 오류)·15초 프레임 정지·인코딩 연속 실패 시 스스로 종료한다 (Agent가 재기동).

## 사용

저장소 루트에서 실행합니다.

```bash
cd mirror-helper
swift build                                   # 배포는 -c release 권장
./.build/debug/mirror-helper --list           # AVFoundation 열거 진단
./.build/debug/mirror-helper --list-cmio      # CMIO 저수준 열거 (UID 확인)
./.build/debug/mirror-helper --name "iPhone 이름" # 기기 이름으로 스트림 시작
```

`--name`은 devicectl의 기기 이름과 일치해야 합니다. 같은 이름의 기기는 구분할 수 없으므로 서로 다른 이름을 사용하세요. 카메라 권한(TCC) 필요 —
최초 실행 시 허용.

## 다중 기기

기기마다 독립된 캡처 장치가 발행되므로 기기당 헬퍼 1프로세스로 확장된다.
여러 기기를 연결할 때는 USB 대역폭과 허브의 전원 공급을 확인하세요.
