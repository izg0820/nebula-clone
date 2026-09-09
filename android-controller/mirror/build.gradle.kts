plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.nebula.mirror"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.nebula.mirror"
        minSdk = 34
        targetSdk = 36
    }

    buildTypes {
        debug {
            // R8 끄기: 리플렉션 대상 보존 + 단일 dex (app_process가 소비)
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
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
