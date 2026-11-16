<?php

/**
 * Phlair's pages: the downloads of the installer and the uninstaller of
 * OneDriphe, Phlair's helper for Windows, which its setting links to. Not in
 * the list of applications, and it can not be uninstalled.
 */
final class PhlairApplication extends PhabricatorApplication {

  public function getName() {
    return pht('Phlair');
  }

  public function getShortDescription() {
    return pht('Tools for Phorge');
  }

  public function getIcon() {
    return 'fa-magic';
  }

  public function canUninstall() {
    return false;
  }

  public function isUnlisted() {
    return true;
  }

  public function getRoutes() {
    return array(
      '/phlair/' => array(
        'onedriphe/(?P<file>(?:un)?install-onedriphe\.ps1)' =>
          'OneDripheDownloadController',
      ),
    );
  }

}
