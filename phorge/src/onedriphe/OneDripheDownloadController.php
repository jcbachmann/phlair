<?php

/**
 * OneDriphe's scripts (onedriphe/ of the library) to download. For Windows,
 * with its line breaks: the installer as one file, with the helper and the
 * uninstaller in it (in the place of its lines
 * "$helper = $null # ONEDRIPHE-HELPER" and "$uninstaller = ..."), and the
 * uninstaller. For Linux: its installer with the helper in it (in the place
 * of its line "write_helper() { ... } # ONEDRIPHE-HELPER").
 */
final class OneDripheDownloadController extends PhabricatorController {

  const INSTALLER = 'install-onedriphe.ps1';
  const UNINSTALLER = 'uninstall-onedriphe.ps1';
  const LINUX_INSTALLER = 'install-onedriphe.sh';

  /** The variables of the installer that get a script, and their scripts. */
  const EMBEDDED = array(
    'helper' => 'onedriphe.ps1',
    'uninstaller' => 'uninstall.ps1',
  );

  public static function getDownloadURI($file) {
    return '/phlair/onedriphe/'.$file;
  }

  public function handleRequest(AphrontRequest $request) {
    $file = $request->getURIData('file');
    if ($file === self::INSTALLER) {
      $content = str_replace("\n", "\r\n", self::newInstaller());
    } else if ($file === self::UNINSTALLER) {
      $content = str_replace("\n", "\r\n", self::read('uninstall.ps1'));
    } else if ($file === self::LINUX_INSTALLER) {
      $content = self::newLinuxInstaller();
    } else {
      return new Aphront404Response();
    }
    return id(new AphrontFileResponse())
      ->setMimeType('text/plain')
      ->setDownload($file)
      ->setContent($content);
  }

  public static function newInstaller() {
    $installer = self::read('install.ps1');
    foreach (self::EMBEDDED as $variable => $file) {
      $script = rtrim(self::read($file));
      $placeholder =
        '$'.$variable.' = $null # ONEDRIPHE-'.strtoupper($variable);
      // In a here-string, which a line starting with "'@" would end.
      if (preg_match("/^'@/m", $script) ||
          substr_count($installer, $placeholder) !== 1) {
        throw new Exception(
          pht('The scripts of OneDriphe do not fit together.'));
      }
      $installer = str_replace(
        $placeholder,
        '$'.$variable." = @'\n".$script."\n'@",
        $installer);
    }
    return $installer;
  }

  public static function newLinuxInstaller() {
    $installer = self::read('install.sh');
    $script = rtrim(self::read('onedriphe.py'));
    $placeholder =
      'write_helper() { cp "$(dirname "$0")/onedriphe.py" "$1"; } '.
      '# ONEDRIPHE-HELPER';
    // In a here-document, which a line "ONEDRIPHE-HELPER" would end.
    if (preg_match('/^ONEDRIPHE-HELPER$/m', $script) ||
        substr_count($installer, $placeholder) !== 1) {
      throw new Exception(pht('The scripts of OneDriphe do not fit together.'));
    }
    return str_replace(
      $placeholder,
      "write_helper() {\n  cat >\"\$1\" <<'ONEDRIPHE-HELPER'\n".$script.
      "\nONEDRIPHE-HELPER\n}",
      $installer);
  }

  /** A script of onedriphe/, with "\n" line breaks. */
  private static function read($file) {
    $root = dirname(phutil_get_library_root('phlair')).'/onedriphe/';
    return str_replace("\r\n", "\n", Filesystem::readFile($root.$file));
  }

}
