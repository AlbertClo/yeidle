{
  description = "Yeidle: local-first notes";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      android = import ./apps/mobile/android.nix { inherit nixpkgs; };
    in
    {
      packages = forAllSystems (pkgs: {
        yeidle = pkgs.callPackage ./apps/electron/package.nix { };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.yeidle;
      });

      # Android (apps/mobile). The SDK requires accepting Google's Android
      # SDK license, which these do.
      #   nix develop .#android        Java + SDK; then npm run android:apk -w @yeidle/mobile
      #   nix run .#android-emulator   boots an emulator and installs the built APK
      devShells.x86_64-linux.android = android.shell;
      apps.x86_64-linux.android-emulator = {
        type = "app";
        program = "${android.emulator}/bin/yeidle-android-emulator";
      };

      overlays.default = final: _prev: {
        yeidle = final.callPackage ./apps/electron/package.nix { };
      };
    };
}
