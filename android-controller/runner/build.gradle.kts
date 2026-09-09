plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.nebula.controller"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.nebula.controller"
        // 보유 기기(ZFold8)만 지원 — 구형 지원 의도 없음을 빌드 설정으로 선언
        minSdk = 34
        targetSdk = 36
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isIncludeAndroidResources = false
    }
}

// 런타임 의존성 0 (Kotlin stdlib만) — 테스트는 JVM 단위 테스트용 JUnit만
dependencies {
    testImplementation("junit:junit:4.13.2")
}
