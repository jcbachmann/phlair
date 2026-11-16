<?php

/**
 * Phizziwig's option "onedriphe" (src/tools.ts): "In Explorer" (Windows) or
 * "In the file manager" (Linux) in the menu of SharePoint links, with
 * OneDriphe, Phlair's helper (phorge/onedriphe/). Not a tool of its own:
 * PhlairMainMenuBarExtension passes it to the script of users who have
 * Phizziwig on.
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
    return pht(
      "A click on a SharePoint link also offers to open it **in Explorer** ".
      "(Windows) or **in the file manager** (Linux): the folder where it is ".
      "synced, with the file selected.\n\n".
      "Needs Phizziwig, and **OneDriphe** on your computer (no administrator ".
      "rights):\n\n".
      '- **Windows:** download the [[ '.
      self::uri($installer).' | installer for Windows ]] (delete older '.
      'downloads of it first) and run it in PowerShell: `powershell '.
      '-ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\\'.
      $installer.'"`. To remove it: Windows Settings → Apps → OneDriphe, or '.
      'run the [[ '.self::uri(OneDripheDownloadController::UNINSTALLER).
      " | uninstaller ]] the same way.\n".
      '- **Linux:** download the [[ '.
      self::uri(OneDripheDownloadController::LINUX_INSTALLER).
      ' | installer for Linux ]] and run `sh ~/Downloads/'.
      OneDripheDownloadController::LINUX_INSTALLER.'`, then list your '.
      'synced libraries in `~/.config/onedriphe/libraries`, as that file '.
      "explains. To remove it: `~/.local/bin/onedriphe --uninstall`.\n\n".
      'Then choose **On** here and save, and allow the browser to open '.
      'OneDriphe on the first click. To update, install again.');
  }

  private static function uri($file) {
    return OneDripheDownloadController::getDownloadURI($file);
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
