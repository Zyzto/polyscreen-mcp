plugins {
    id("com.android.application")
}

android {
    namespace = "dev.bettermobile.companion"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.bettermobile.companion"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "dev.bettermobile.companion.BridgeInstrumentation"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
