<?php

/**
 * OneDriphe's scripts (onedriphe/ of the library) to download, with Windows'
 * line breaks: the installer as one file, with the helper and the
 * uninstaller in it (in the place of its lines
 * "$helper = $null # ONEDRIPHE-HELPER" and "$uninstaller = ..."), and the
 * uninstaller.
 */
final class OneDripheDownloadController extends PhabricatorController {

  const INSTALLER = 'install-onedriphe.ps1';
  const UNINSTALLER = 'uninstall-onedriphe.ps1';

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
      $content = self::newInstaller();
    } else if ($file === self::UNINSTALLER) {
      $content = self::read('uninstall.ps1');
    } else {
      return new Aphront404Response();
    }
    return id(new AphrontFileResponse())
      ->setMimeType('text/plain')
      ->setDownload($file)
      ->setContent(str_replace("\n", "\r\n", $content));
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

  /** A script of onedriphe/, with "\n" line breaks. */
  private static function read($file) {
    $root = dirname(phutil_get_library_root('phlair')).'/onedriphe/';
    return str_replace("\r\n", "\n", Filesystem::readFile($root.$file));
  }

}
