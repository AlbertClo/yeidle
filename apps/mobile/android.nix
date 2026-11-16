# Android tooling for apps/mobile (x86_64 Linux): a shell to build the APK
# and an emulator that runs it. Importing the SDK means accepting Google's
# Android SDK license.
{ nixpkgs }:
let
  pkgs = import nixpkgs {
    system = "x86_64-linux";
    config = {
      allowUnfree = true;
      android_sdk.accept_license = true;
    };
  };

  platformVersion = "36";
  buildTools = "35.0.0";

  sdkArgs = {
    platformVersions = [ platformVersion ];
    buildToolsVersions = [ buildTools ];
    includeNDK = false;
  };

  build = pkgs.androidenv.composeAndroidPackages (sdkArgs // { includeEmulator = false; });
  sdk = "${build.androidsdk}/libexec/android-sdk";

  # Boots a virtual phone (kept in ~/.local/share/yeidle-android between
  # runs) and waits until Android is ready
  device = pkgs.androidenv.emulateApp {
    name = "yeidle-device";
    inherit platformVersion;
    abiVersion = "x86_64";
    systemImageType = "google_apis";
    deviceName = "yeidle";
    androidUserHome = "$HOME/.local/share/yeidle-android";
    configOptions = {
      "hw.gpu.enabled" = "yes";
      "hw.keyboard" = "yes";
    };
    sdkExtraArgs = sdkArgs;
  };
in
{
  shell = pkgs.mkShell {
    packages = [
      pkgs.jdk21
      pkgs.nodejs_22
      build.androidsdk
    ];
    ANDROID_HOME = sdk;
    ANDROID_SDK_ROOT = sdk;
    JAVA_HOME = pkgs.jdk21.home;
    # Gradle's own aapt2 download is a generic Linux binary that NixOS
    # can't run; use the SDK's
    GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${sdk}/build-tools/${buildTools}/aapt2";
  };

  # Run from the repository root after building the APK
  emulator = pkgs.writeShellScriptBin "yeidle-android-emulator" ''
    set -euo pipefail
    apk=apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk

    if [ ! -f "$apk" ]; then
      echo "Build the APK first: nix develop .#android, then npm run android:apk -w @yeidle/mobile" >&2
      exit 1
    fi

    ${device}/bin/run-test-emulator
    adb=${sdk}/platform-tools/adb
    # Typing happens on the computer's keyboard: switch off the on-screen
    # keyboard apps (and Gboard's floating toolbar for physical keyboards).
    # Disabling only their input methods doesn't last
    for app in com.google.android.inputmethod.latin com.google.android.tts; do
      $adb -e shell pm disable-user --user 0 "$app" >/dev/null 2>&1 || true
    done
    $adb -e install -r "$apk"
    $adb -e shell am start -n com.yeidle.app/.MainActivity
    echo "Yeidle is running in the emulator. Close the emulator window to stop it."
  '';
}
