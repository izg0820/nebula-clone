# Android Controller

Kotlin으로 구현한 기기 제어 러너와 H.264 미러링 데몬입니다.
전체 스택 실행은 [루트 README](../README.md)를 참고하세요.

| 모듈 | 역할 |
|---|---|
| `runner` | Instrumentation APK. UiAutomation으로 탭·스와이프·입력·UI 덤프·스크린샷 처리 |
| `mirror` | shell 권한의 app_process 데몬. 가상 디스플레이와 MediaCodec으로 H.264 인코딩 |

## 준비·빌드

JDK 17 이상, Android SDK Platform 36, Build Tools 36.0.0, adb가 필요합니다.
저장소 루트에서 실행합니다.

```bash
cp android-controller/local.properties.example android-controller/local.properties
```

`local.properties`의 `sdk.dir`를 SDK 설치 경로로 수정한 뒤 빌드합니다.

```bash
bash scripts/build-android.sh
```

Agent는 빌드 산출물 경로를 자동으로 사용하며, adb가 있으면 Android를 활성화합니다.
기기의 USB 디버깅을 켜고 최초 연결 시 컴퓨터 접근을 허용하세요.
삼성 기기에서 설치가 차단되면 Auto Blocker 설정을 확인하세요.

## 연결 진단

```bash
adb devices
bash scripts/android-probe.sh
```

미러링에는 shell의 `CAPTURE_VIDEO_OUTPUT` 권한과 비공개 가상 디스플레이 API가 필요합니다.
프로브는 기기 정보·권한·디스플레이 상태를 확인하는 용도입니다.
출력에는 기기 식별자가 포함되므로 공유할 때 해당 값을 제거하세요.

## 확인된 호환 범위

| 기기 | OS | 확인한 동작 |
|---|---|---|
| ZFold8 (SM-F971N) | Android 17 | 제어·미러링, 접힘·펼침 시 스트림 해상도 전환 |

미러링은 논리 디스플레이 0을 사용하며 해상도 변경을 감지하면 인코더를 재구성합니다.
다른 제조사·OS 버전의 비공개 API 호환성은 미검증입니다.

## 제약

- `FLAG_SECURE` 화면은 미러링 불가
- 다른 UiAutomation 기반 도구(Appium 등)와 동시 제어 불가
- 기기·OS 업데이트에 따라 비공개 API 호환성 재확인 필요
