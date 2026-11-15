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
    in
    {
      packages = forAllSystems (pkgs: {
        yeidle = pkgs.callPackage ./apps/electron/package.nix { };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.yeidle;
      });

      overlays.default = final: _prev: {
        yeidle = final.callPackage ./apps/electron/package.nix { };
      };
    };
}
