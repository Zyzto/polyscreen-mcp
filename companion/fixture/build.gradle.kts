plugins {
    id("com.android.application")
}

android {
    namespace = "dev.polyscreen.fixture"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.polyscreen.fixture"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
