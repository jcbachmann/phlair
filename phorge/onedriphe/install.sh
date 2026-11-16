#!/bin/sh
# Installs OneDriphe for Linux (onedriphe.py, see README.md) for this user, no
# root needed: the helper as ~/.local/bin/onedriphe, and the scheme
# "onedriphe:" for it (a desktop entry, the default for the scheme). To
# update, run it again; to remove: onedriphe --uninstall.
set -eu

bin="$HOME/.local/bin"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
config="${XDG_CONFIG_HOME:-$HOME/.config}/onedriphe"

# The helper. Phorge's download has it in place of this line (OneDripheDownloadController); else the file next to this one.
write_helper() { cp "$(dirname "$0")/onedriphe.py" "$1"; } # ONEDRIPHE-HELPER

if ! command -v python3 >/dev/null 2>&1; then
  echo "OneDriphe needs Python 3 (python3), which is not installed." >&2
  exit 1
fi
# The desktop entry names the helper in quotes, where these would need escapes.
case "$bin" in
  *[\"\`\$\\%]*)
    echo "OneDriphe can not be installed in $bin." >&2
    exit 1
    ;;
esac

mkdir -p "$bin" "$apps" "$config"
write_helper "$bin/onedriphe.new"
chmod 755 "$bin/onedriphe.new"
mv -f "$bin/onedriphe.new" "$bin/onedriphe"

cat >"$apps/onedriphe.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=OneDriphe
Comment=Opens SharePoint links of Phorge in the file manager
Exec="$bin/onedriphe" %u
MimeType=x-scheme-handler/onedriphe;
NoDisplay=true
Terminal=false
EOF
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$apps" 2>/dev/null || true
fi
if command -v xdg-mime >/dev/null 2>&1; then
  xdg-mime default onedriphe.desktop x-scheme-handler/onedriphe
else
  echo "xdg-mime (xdg-utils) is missing: the browser may not find OneDriphe." >&2
fi

if [ ! -e "$config/libraries" ]; then
  cat >"$config/libraries" <<'EOF'
# The SharePoint libraries on this computer, for OneDriphe: one per line, the
# library's URL (as the browser shows it, without "/Forms/..."), then its
# folder (e.g. where rclone mounts it). For example:
#
# https://contoso.sharepoint.com/sites/Projects/Shared%20Documents ~/SharePoint/Projects
EOF
fi

echo "OneDriphe is installed as $bin/onedriphe."
"$bin/onedriphe" --list
echo "Add your libraries to $config/libraries; to check them: $bin/onedriphe --list"
