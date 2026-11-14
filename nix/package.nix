{
  lib,
  buildNpmPackage,
  electron,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
}:

# The Electron desktop app (apps/electron), run by nixpkgs' Electron.
#
# After changing package-lock.json, update npmDepsHash:
#   nix run nixpkgs#prefetch-npm-deps -- package-lock.json

let
  appPackage = lib.importJSON ../apps/electron/package.json;
in
buildNpmPackage {
  pname = "yeidle";
  inherit (appPackage) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      (lib.fileset.difference ../packages (
        lib.fileset.maybeMissing ../packages/core/node_modules
      ))
      (lib.fileset.difference ../apps/electron (
        lib.fileset.unions [
          (lib.fileset.maybeMissing ../apps/electron/node_modules)
          (lib.fileset.maybeMissing ../apps/electron/out)
        ]
      ))
    ];
  };

  npmDepsHash = "sha256-/tXkX8ZH4JRNkiijW4Bp6dLjXd6T9viGWUaR5HSQzQY=";

  # Electron comes from nixpkgs; nothing else needs install scripts (native
  # tool binaries such as esbuild's arrive as optional dependencies)
  npmFlags = [ "--ignore-scripts" ];
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [
    makeWrapper
    copyDesktopItems
  ];

  buildPhase = ''
    runHook preBuild
    npm run build --workspace @yeidle/electron
    runHook postBuild
  '';

  # The bundles plus Loro (the main process loads its WebAssembly from disk)
  installPhase = ''
    runHook preInstall

    app=$out/share/yeidle/app
    mkdir -p $app/node_modules
    cp -r apps/electron/out $app/out
    cp -r node_modules/loro-crdt $app/node_modules/loro-crdt
    cat > $app/package.json <<EOF
    {
      "name": "yeidle",
      "productName": "Yeidle",
      "version": "${appPackage.version}",
      "type": "module",
      "main": "out/main/index.js"
    }
    EOF

    install -Dm644 apps/electron/build/icon.png \
      $out/share/icons/hicolor/512x512/apps/yeidle.png
    install -Dm644 apps/electron/build/icon.svg \
      $out/share/icons/hicolor/scalable/apps/yeidle.svg

    makeWrapper ${lib.getExe electron} $out/bin/yeidle \
      --add-flags $app \
      --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations}}" \
      --inherit-argv0

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "yeidle";
      desktopName = "Yeidle";
      comment = appPackage.description;
      exec = "yeidle %U";
      icon = "yeidle";
      categories = [
        "Office"
        "Utility"
      ];
      startupWMClass = "Yeidle";
    })
  ];

  meta = {
    description = "Local-first notes";
    homepage = "https://github.com/AlbertClo/yeidle";
    mainProgram = "yeidle";
    platforms = lib.platforms.linux;
  };
}
