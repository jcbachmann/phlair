<?php

/**
 * The setting of one of Phlair's tools, On or Off; its key is the tool's
 * name in the script (src/tools.ts). Phorge adds "Default (...)": the user
 * then follows the Global Default Settings, where the administrator chooses.
 * Every tool is off by default, until the administrator or the user turns it on.
 */
abstract class PhlairToolSetting
  extends PhabricatorSelectSetting {

  const VALUE_ENABLED = 'enabled';
  const VALUE_DISABLED = 'disabled';

  final public function getSettingPanelKey() {
    return PhlairSettingsPanel::PANELKEY;
  }

  final protected function getSelectOptions() {
    return array(
      self::VALUE_ENABLED => pht('On'),
      self::VALUE_DISABLED => pht('Off'),
    );
  }

  /**
   * Whether the user has the tool of this setting on, e.g.
   * PhizziwigSetting::isEnabledFor($viewer).
   */
  final public static function isEnabledFor(PhabricatorUser $viewer) {
    return $viewer->isLoggedIn() &&
      $viewer->getUserSetting(static::SETTINGKEY) === self::VALUE_ENABLED;
  }

  /**
   * The tools the user has on.
   *
   * @return list<string>
   */
  final public static function getEnabledTools(PhabricatorUser $viewer) {
    $settings = id(new PhutilClassMapQuery())
      ->setAncestorClass(__CLASS__)
      ->execute();

    $tools = array();
    foreach ($settings as $setting) {
      if ($setting::isEnabledFor($viewer)) {
        $tools[] = $setting->getSettingKey();
      }
    }
    return $tools;
  }

}
