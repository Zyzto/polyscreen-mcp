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
        versionCode = 3
        versionName = "0.2.5"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
