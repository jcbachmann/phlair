<?php

/**
 * Phizziwig's option "onedriphe" (src/tools.ts): "In Explorer" in the menu of
 * SharePoint links, with OneDriphe, Phlair's helper for Windows
 * (phorge/onedriphe/). Not a tool of its own: PhlairMainMenuBarExtension
 * passes it to the script of users who have Phizziwig on.
 */
final class OneDripheSetting extends PhabricatorSelectSetting {

  const SETTINGKEY = 'onedriphe';

  const VALUE_ENABLED = 'enabled';
  const VALUE_DISABLED = 'disabled';

  public function getSettingName() {
    return pht('OneDriphe: SharePoint Links');
  }

  public function getSettingPanelKey() {
    return PhlairSettingsPanel::PANELKEY;
  }

  protected function getControlInstructions() {
    $installer = OneDripheDownloadController::INSTALLER;
    $uninstaller = OneDripheDownloadController::UNINSTALLER;
    return pht(
      "On Windows, a click on a SharePoint link also offers to open it **in ".
      "Explorer**: the folder where OneDrive syncs it, with the file ".
      "selected.\n\n".
      "Needs Phizziwig, and **OneDriphe** on your computer. To install it ".
      "(no administrator rights):\n\n".
      '# [[ '.OneDripheDownloadController::getDownloadURI($installer).
      ' | Download the installer ]] (delete older downloads of it first).'.
      "\n".
      '# Open PowerShell and run: `powershell -ExecutionPolicy Bypass -File '.
      '"$env:USERPROFILE\Downloads\\'.$installer."\"`\n".
      '# Choose **On** here and save. Allow the browser to open the app on '.
      "the first click.\n\n".
      'To update, install again. To remove: Windows Settings → Apps → '.
      'OneDriphe, or run the [[ '.
      OneDripheDownloadController::getDownloadURI($uninstaller).
      ' | uninstaller ]] the same way.');
  }

  protected function getSelectOptions() {
    return array(
      self::VALUE_ENABLED => pht('On'),
      self::VALUE_DISABLED => pht('Off'),
    );
  }

  public function getSettingDefaultValue() {
    return self::VALUE_DISABLED;
  }

  public static function isEnabledFor(PhabricatorUser $viewer) {
    return $viewer->isLoggedIn() &&
      $viewer->getUserSetting(self::SETTINGKEY) === self::VALUE_ENABLED;
  }

}
