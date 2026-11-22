// SPDX-License-Identifier: GPL-3.0-only

// The pointer the Remote's mouse shows on the TV: a tiny app with one overlay window and no screen
// of its own. Java only, debug-signed (so a TV installs it), and bundled into :app as an asset.
plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "app.tellyscope.cursor"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.tellyscope.cursor"
        minSdk = 26
        // Under 34, so its foreground service needs no declared type.
        targetSdk = 28
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
