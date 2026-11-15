#!/usr/bin/env bash
#
# Builds Yeidle from this checkout and installs it in your Nix profile (or
# updates the installed copy), then makes sure the app is in the desktop
# menu. Run it again after pulling or committing changes:
#
#   npm run install:desktop
#
# Nix builds the files git knows about: committed and modified files are
# included, new files that were never `git add`ed are not.

set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
package=apps/electron/package.nix
cd "$root"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

untracked=$(git ls-files --others --exclude-standard -- apps packages flake.nix)

if [ -n "$untracked" ]; then
    say "Warning: these files aren't tracked by git, so the build won't include them:"
    printf '  %s\n' $untracked
fi

# 1. Build. The build downloads npm packages by a pinned hash
#    (npmDepsHash); when package-lock.json changed, Nix reports the new hash
#    and the build is retried with it.
say "Building Yeidle…"
log=$(mktemp)
trap 'rm -f "$log"' EXIT

if ! nix build "$root#yeidle" --no-link 2>&1 | tee "$log"; then
    got=$(grep -oE 'got: +sha256-[A-Za-z0-9+/=]+' "$log" | grep -oE 'sha256-.*' | tail -1 || true)

    if [ -z "$got" ]; then
        say "The build failed."
        exit 1
    fi

    say "package-lock.json changed: updating npmDepsHash in $package to $got"
    sed -i -E "s|npmDepsHash = \"sha256-[^\"]*\";|npmDepsHash = \"$got\";|" "$package"
    nix build "$root#yeidle" --no-link
fi

# 2. Install, or update the copy installed from this checkout
installed_from=$(nix profile list --json | python3 -c '
import json, sys
element = json.load(sys.stdin)["elements"].get("yeidle")
print(element["originalUrl"] if element else "")
')

if [ "$installed_from" = "git+file://$root" ]; then
    say "Updating the installed app…"
    nix profile upgrade yeidle
else
    if [ -n "$installed_from" ]; then
        say "Replacing the copy installed from $installed_from…"
        nix profile remove yeidle
    else
        say "Installing…"
    fi

    nix profile add "$root#yeidle"
fi

# 3. Desktop entry. Desktops don't always look in the Nix profile, so link
#    the entry into ~/.local/share/applications. The link goes through the
#    profile, so it stays valid across updates.
entry="$HOME/.local/share/applications/yeidle.desktop"
mkdir -p "$(dirname "$entry")"
ln -sfn "$HOME/.nix-profile/share/applications/yeidle.desktop" "$entry"

if command -v kbuildsycoca6 >/dev/null; then
    kbuildsycoca6 >/dev/null 2>&1 || true
elif command -v update-desktop-database >/dev/null; then
    update-desktop-database "$(dirname "$entry")" || true
fi

say "Done: $(readlink -f "$HOME/.nix-profile/bin/yeidle")"

if pgrep -x yeidle >/dev/null || pgrep -f 'yeidle/.*electron' >/dev/null; then
    say "Yeidle is running: quit and reopen it to use the new version."
fi
