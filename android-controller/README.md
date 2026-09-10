# android-controller

Android 러너(제어) + 미러링 데몬 — Kotlin/Gradle, `controller-ios/`와 대칭.
설계·프로토콜·온보딩 전체는 루트 README와 CLAUDE.md Phase 5 참고.

- **runner 모듈**: 커스텀 Instrumentation 단일 APK (의존성 0, self-instrumenting).
  iOS 러너와 동일한 Controller HTTP 계약 구현 — Agent 명령 경로 무변경 재사용
- **mirror 모듈**: app_process(shell UID)용 dex — SurfaceControl 가상 디스플레이 + MediaCodec H.264

빌드: `scripts/build-android.sh` (JDK 17+ 자동 선택, `local.properties.example` 복사 후 sdk.dir 확인)

## 지원 기기

hidden API 사용(미러링)은 **보유 기기에서 실측 검증된 조합만 지원** — 원문(토스)도 자사 기기군만 지원.
새 기기는 `scripts/android-probe.sh`로 게이트(U1) 통과를 먼저 확인할 것.

| 기기 | 모델 | OS/SDK | 빌드 | U1 (shell CAPTURE_VIDEO_OUTPUT) | 판정 |
|---|---|---|---|---|---|
| ZFold8 | SM-F971N | Android 17 / SDK 37 | CP2A.260605.016.F971NKSS2AZH7 | granted=true (+ACCESS_SURFACE_FLINGER, INJECT_EVENTS) | 통과 (2026-09-09) |

판정 요약 (2026-09-09, **접힌 상태**에서 실행):

- **U1 통과** — shell(uid 2000)이 `CAPTURE_VIDEO_OUTPUT: granted=true`. app_process 미러링 데몬 설계 유효
- **U3 통과** (접힘·펼침 양쪽 실측, 2026-09-10 교차 확인) — 물리 패널 2개(내부 2448×1848,
  커버 1248×1972)가 접힘 상태에 따라 스왑되며 **활성 패널이 항상 logical displayId 0에 매핑**.
  미러링은 displayId 0 고정 + DisplayProbe 폴링으로 충분. 접힘→펼침 전환 시 데몬이
  "해상도 변경: 1248x1972 → 2448x1848 — 세션 재구성" 후 스트림 자동 지속 (실기기 검증)
- **U7** — SDK 37 기기. compileSdk 36 APK도 minSdk 34 ≤ 37이라 설치·구동 가능 (compileSdk는
  컴파일 타임 상한일 뿐) — 36 유지
- **U6 참고** — `hidden_api_policy` 미설정(null)이 정상, 우리는 변경하지 않음
- **U2 통과** (2026-09-10 실측) — `--probe` 결과: `createVirtualDisplay(hidden static): FOUND`,
  `getDisplayInfo: OK`. 실제 미러링도 실기기 동작 확인 (활성 화면 50fps, 서버 릴레이 경유)
- **U4 통과** (2026-09-09 실측) — `am force-stop` 시 호스트 `am instrument -w` 프로세스가 즉시 exit,
  수퍼바이저가 감지해 9초 내 재기동·헬스 복구

### 프로브 원문 (ZFold8, 2026-09-09, 접힌 상태)

<details>
<summary>scripts/android-probe.sh 출력 전문</summary>

```text
═══ 기기: R5KL803AEAM
── [U7] 기기 정보
SM-F971N
17
37
CP2A.260605.016.F971NKSS2AZH7

── [U1] shell 권한 (CAPTURE_VIDEO_OUTPUT 필수 — 미러링 게이트)
      android.permission.ACCESS_SURFACE_FLINGER
      android.permission.ACCESS_SURFACE_FLINGER: granted=true
      android.permission.CAPTURE_VIDEO_OUTPUT
      android.permission.CAPTURE_VIDEO_OUTPUT: granted=true
      android.permission.INJECT_EVENTS
      android.permission.INJECT_EVENTS: granted=true

── [U3] 디스플레이 구조 (접힌 상태와 펼친 상태에서 각각 실행해 비교할 것)
  DisplayDeviceInfo{"내장 화면": uniqueId="local:4630947004648141459", 2448 x 1848, modeId 1, renderFrameRate 30.000006, hasArrSupport true, frameRateCategoryRate FrameRateCategoryRate {normal=60.0, high=90.0}, supportedRefreshRates [120.00002, 80.000015, 60.00001, 48.000008, 40.000008, 34.28572, 30.000006, 26.666672, 24.000004, 21.818184, 20.000004], defaultModeId 1, userPreferredModeId -1, supportedModes [{id=1, parentModeId=-1, sfModeId=0, flags=, width=2448, height=1848, fps=120.00001, vsync=240.00005, alternativeRefreshRates=[], supportedHdrTypes=[2, 3, 4]}, {id=2, parentModeId=1, sfModeId=-1, flags=, FLAG_ARR_RENDER_RATE, width=2448, height=1848, fps=60.0, vsync=60.0, alternativeRefreshRates=[], supportedHdrTypes=[2, 3, 4]}], colorMode 0, supportedColorModes [0, 7, 9], hdrCapabilities HdrCapabilities{mSupportedHdrTypes=[2, 3, 4], mMaxLuminance=1351.0, mMaxAverageLuminance=1351.0, mMinLuminance=5.0E-4}, isForceSdr false, allmSupported false, gameContentTypeSupported false, density 420, 403.76105 x 404.64825 dpi, appVsyncOff 16666440, presDeadline 9333444, touch INTERNAL, rotation 0, type INTERNAL, address StablePhysical{id=4630947004648141459, port=147}, deviceProductInfo DeviceProductInfo{name=, manufacturerPnpId=QCM, productId=1, modelYear=null, manufactureDate=ManufactureDate{week=27, year=2006}, connectionToSinkType=1, edidStructureMetadata=EdidStructureMetadata{version=0, revision=0}, videoInputType=0}, state OFF, committedState OFF, frameRateOverride {uid=10055 frameRateHz=30.000006} , brightnessMinimum 0.0, brightnessMaximum 5.2980394, brightnessDefault 0.5019609, brightnessDim 0.04705883, hdrSdrRatio 1.0, roundedCorners RoundedCorners{[RoundedCorner{position=TopLeft, radius=18, center=Point(18, 18)}, RoundedCorner{position=TopRight, radius=18, center=Point(2430, 18)}, RoundedCorner{position=BottomRight, radius=18, center=Point(2430, 1830)}, RoundedCorner{position=BottomLeft, radius=18, center=Point(18, 1830)}]}, FLAG_ALLOWED_TO_BE_DEFAULT_DISPLAY, FLAG_ROTATES_WITH_CONTENT, FLAG_SECURE, FLAG_SUPPORTS_PROTECTED_BUFFERS, FLAG_OWN_CONTENT_ONLY, FLAG_TRUSTED, installOrientation 3, displayShape DisplayShape{type=2, displayWidth=2448, displayHeight=1848, physicalPixelDisplaySizeRatio=1.0, rotation=0, offsetX=0, offsetY=0, scale=1.0}}
  DisplayDeviceInfo{"내장 화면": uniqueId="local:4630947123231501204", 1248 x 1972, modeId 3, renderFrameRate 48.000008, hasArrSupport true, frameRateCategoryRate FrameRateCategoryRate {normal=60.0, high=90.0}, supportedRefreshRates [120.00002, 80.000015, 60.00001, 48.000008, 40.000008, 34.28572, 30.000006, 26.666672, 24.000004, 21.818184, 20.000004], defaultModeId 3, userPreferredModeId -1, supportedModes [{id=3, parentModeId=-1, sfModeId=0, flags=, width=1248, height=1972, fps=120.00001, vsync=240.00005, alternativeRefreshRates=[], supportedHdrTypes=[2, 3, 4]}, {id=4, parentModeId=3, sfModeId=-1, flags=, FLAG_ARR_RENDER_RATE, width=1248, height=1972, fps=60.0, vsync=60.0, alternativeRefreshRates=[], supportedHdrTypes=[2, 3, 4]}], colorMode 0, supportedColorModes [0, 7, 9], hdrCapabilities HdrCapabilities{mSupportedHdrTypes=[2, 3, 4], mMaxLuminance=1351.0, mMaxAverageLuminance=1351.0, mMinLuminance=5.0E-4}, isForceSdr false, allmSupported false, gameContentTypeSupported false, density 420, 428.36755 x 428.1094 dpi, appVsyncOff 4166442, presDeadline 9333444, cutout DisplayCutout{insets=Rect(0, 104 - 0, 0) waterfall=Insets{left=0, top=0, right=0, bottom=0} boundingRect={Bounds=[Rect(0, 0 - 0, 0), Rect(589, 0 - 659, 104), Rect(0, 0 - 0, 0), Rect(0, 0 - 0, 0)]} cutoutPathParserInfo={CutoutPathParserInfo{displayWidth=1248 displayHeight=1972 physicalDisplayWidth=1248 physicalDisplayHeight=1972 density={2.625} cutoutSpec={M 0,0 H -13.33333333333333 V 39.61904761904762 H 13.33333333333333 V 0 H 0 Z @dp} rotation={0} scale={1.0} physicalPixelDisplaySizeRatio={1.0}}} sideOverrides={}}, touch INTERNAL, rotation 0, type INTERNAL, address StablePhysical{id=4630947123231501204, port=148}, deviceProductInfo DeviceProductInfo{name=, manufacturerPnpId=QCM, productId=1, modelYear=null, manufactureDate=ManufactureDate{week=27, year=2006}, connectionToSinkType=1, edidStructureMetadata=EdidStructureMetadata{version=0, revision=0}, videoInputType=0}, state ON, committedState ON, frameRateOverride , brightnessMinimum 0.0, brightnessMaximum 5.2980394, brightnessDefault 0.5019609, brightnessDim 0.04705883, hdrSdrRatio 1.0, roundedCorners RoundedCorners{[RoundedCorner{position=TopLeft, radius=26, center=Point(26, 26)}, RoundedCorner{position=TopRight, radius=26, center=Point(1222, 26)}, RoundedCorner{position=BottomRight, radius=26, center=Point(1222, 1946)}, RoundedCorner{position=BottomLeft, radius=26, center=Point(26, 1946)}]}, FLAG_ALLOWED_TO_BE_DEFAULT_DISPLAY, FLAG_ROTATES_WITH_CONTENT, FLAG_SECURE, FLAG_SUPPORTS_PROTECTED_BUFFERS, FLAG_PRESENTATION, FLAG_OWN_CONTENT_ONLY, FLAG_TRUSTED, FLAG_EXTRA_BUILT_IN_DISPLAY, installOrientation 0, displayShape DisplayShape{type=2, displayWidth=1248, displayHeight=1972, physicalPixelDisplaySizeRatio=1.0, rotation=0, offsetX=0, offsetY=0, scale=1.0}}
    mDisplayId=0
    mDisplayId=1
  mDisplayId=0
  mDisplayId=0
  mDisplayId=: 0
  mDisplayId= 0
  mDisplayId=0
  mDisplayId=0
  09-09 12:03:58.855 - BrightnessEvent: brt=0.47843137(86.0%), nits=192.367, lux=-1.0, reason=doze, strat=DozeBrightnessStrategy, state=DOZE, stateReason=UNKNOWN, policy=DOZE, flags=, initBrt=0.0, rcmdBrt=NaN, preBrt=NaN, preLux=0.0, wasShortTermModelActive=false, autoBrightness=true (default), unclampedBrt=0.47843137, hbmMax=1.0, hbmMode=off, thrmMax=1.0, rbcStrength=-1, powerFactor=1.0, physDisp=내장 화면(local:4630947123231501204), logicalId=0, slowChange=false, rampSpeed=0.0, colorTemp=NaN, thermalStatus=none
  09-09 12:03:58.962 - BrightnessEvent: brt=0.0(0.0%), nits=1.0, lux=-1.0, reason=screen_off, strat=ScreenOffBrightnessStrategy, state=OFF, stateReason=UNKNOWN, policy=DOZE, flags=, initBrt=0.47843137, rcmdBrt=NaN, preBrt=NaN, preLux=0.0, wasShortTermModelActive=false, autoBrightness=true (default), unclampedBrt=0.0, hbmMax=1.0, hbmMode=off, thrmMax=1.0, rbcStrength=-1, powerFactor=1.0, physDisp=내장 화면(local:4630947123231501204), logicalId=0, slowChange=false, rampSpeed=0.0, colorTemp=NaN, thermalStatus=none
  09-09 12:03:59.136 - BrightnessEvent: brt=0.0(0.0%), nits=1.0, lux=-1.0, reason=last_target, strat=LastTargetBrightnessStrategy, state=DOZE, stateReason=UNKNOWN, policy=DOZE, flags=, initBrt=0.0, rcmdBrt=NaN, preBrt=NaN, preLux=0.0, wasShortTermModelActive=false, autoBrightness=true (default), unclampedBrt=0.0, hbmMax=1.0, hbmMode=off, thrmMax=1.0, rbcStrength=-1, powerFactor=1.0, physDisp=내장 화면(local:4630947123231501204), logicalId=0, slowChange=false, rampSpeed=0.0, colorTemp=NaN, thermalStatus=none
  09-09 12:03:59.462 - BrightnessEvent: brt=0.5647059(89.0%), nits=238.39398, lux=-1.0, reason=doze, strat=DozeBrightnessStrategy, state=DOZE, stateReason=UNKNOWN, policy=DOZE, flags=, initBrt=0.0, rcmdBrt=NaN, preBrt=NaN, preLux=0.0, wasShortTermModelActive=false, autoBrightness=true (default), unclampedBrt=0.5647059, hbmMax=1.0, hbmMode=off, thrmMax=1.0, rbcStrength=-1, powerFactor=1.0, physDisp=내장 화면(local:4630947123231501204), logicalId=0, slowChange=false, rampSpeed=0.0, colorTemp=NaN, thermalStatus=none
  09-09 12:04:07.722 - BrightnessEvent: brt=0.5647059(89.0%), nits=238.39398, lux=-1.0, reason=last_target, strat=LastTargetBrightnessStrategy, state=DOZE, stateReason=DEFAULT_POLICY, policy=BRIGHT, flags=, initBrt=0.5647059, rcmdBrt=NaN, preBrt=NaN, preLux=0.0, wasShortTermModelActive=false, autoBrightness=true (default), unclampedBrt=0.5647059, hbmMax=1.0, hbmMode=off, thrmMax=1.0, rbcStrength=-1, powerFactor=1.0, physDisp=내장 화면(local:4630947123231501204), logicalId=0, slowChange=false, rampSpeed=0.0, colorTemp=NaN, thermalStatus=none
  09-09 12:04:07.742 - BrightnessEvent: brt=0.5647059(89.0%), nits=238.39398, lux=-1.0, reason=last_target, strat=LastTargetBrightnessStrategy, state=ON, stateReason=DEFAULT_POLICY, policy=BRIGHT, flags=, initBrt=0.5647059, rcmdBrt=NaN, preBrt=NaN, preLux=0.0, wasShortTermModelActive=false, autoBrightness=true (default), unclampedBrt=0.5647059, hbmMax=1.0, hbmMode=off, thrmMax=1.0, rbcStrength=-1, powerFactor=1.0, physDisp=내장 화면(local:4630947123231501204), logicalId=0, slowChange=false, rampSpeed=0.0, colorTemp=NaN, thermalStatus=none
  09-09 12:04:07.801 - BrightnessEvent: brt=0.43915036(85.0%), nits=172.19788, lux=816.0, reason=automatic, strat=AutomaticBrightnessStrategy, state=ON, stateReason=DEFAULT_POLICY, policy=BRIGHT, flags=, initBrt=0.5647059, rcmdBrt=0.43915036, preBrt=0.0, preLux=-1.0, lastReadLux=816.0, wasShortTermModelActive=false, autoBrightness=true (default), unclampedBrt=0.43915036, hbmMax=1.0, hbmMode=off, thrmMax=1.0, rbcStrength=-1, powerFactor=1.0, physDisp=내장 화면(local:4630947123231501204), logicalId=0, slowChange=false, rampSpeed=0.03, colorTemp=NaN, thermalStatus=none
  09-09 12:08:00.604 - BrightnessEvent: brt=0.04705883(38.0%), nits=10.387, lux=816.0, reason=automatic [ dim ], strat=AutomaticBrightnessStrategy, state=ON, stateReason=DEFAULT_POLICY, policy=DIM, flags=, initBrt=0.43915036, rcmdBrt=0.43915036, preBrt=0.0, preLux=-1.0, lastReadLux=949.0, wasShortTermModelActive=false, autoBrightness=true (default), unclampedBrt=0.43915036, hbmMax=1.0, hbmMode=off, thrmMax=1.0, rbcStrength=-1, powerFactor=1.0, physDisp=내장 화면(local:4630947123231501204), logicalId=0, slowChange=false, rampSpeed=0.70472443, colorTemp=NaN, thermalStatus=none
  09-09 12:08:20.604 - BrightnessEvent: brt=0.43915036(85.0%), nits=172.19788, lux=816.0, reason=automatic, strat=AutomaticBrightnessStrategy, state=ON, stateReason=DEFAULT_POLICY, policy=OFF, flags=, initBrt=0.04705883, rcmdBrt=0.43915036, preBrt=0.0, preLux=-1.0, lastReadLux=954.0, wasShortTermModelActive=false, autoBrightness=true (default), unclampedBrt=0.43915036, hbmMax=1.0, hbmMode=off, thrmMax=1.0, rbcStrength=-1, powerFactor=1.0, physDisp=내장 화면(local:4630947123231501204), logicalId=0, slowChange=false, rampSpeed=0.0, colorTemp=NaN, thermalStatus=none
  09-09 12:08:20.971 - BrightnessEvent: brt=0.0(0.0%), nits=1.0, lux=-1.0, reason=screen_off, strat=ScreenOffBrightnessStrategy, state=OFF, stateReason=DEFAULT_POLICY, policy=OFF, flags=, initBrt=0.43915036, rcmdBrt=NaN, preBrt=NaN, preLux=0.0, wasShortTermModelActive=false, autoBrightness=true (default), unclampedBrt=0.0, hbmMax=1.0, hbmMode=off, thrmMax=1.0, rbcStrength=-1, powerFactor=1.0, physDisp=내장 화면(local:4630947123231501204), logicalId=0, slowChange=false, rampSpeed=0.0, colorTemp=NaN, thermalStatus=none
── wm size
Physical size: 1248x1972

── wm density
Physical density: 420

── [U6 참고] hidden_api_policy (미설정이 정상 — 우리는 변경하지 않음)
null

── [U2] hidden DisplayManager.createVirtualDisplay 존재 여부는 미러 데몬 기동 시 리플렉션 로그로 판명
── [U4] am instrument 수명은 러너 구현 후: adb shell 프로세스 kill → adb shell ps -A | grep nebula
═══ 프로브 완료 — 이 출력을 android-controller/README.md '지원 기기' 섹션에 붙여넣기
```

</details>
