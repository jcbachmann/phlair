<?php

/**
 * Loads Phlair on every page for users who have one of its tools on, and
 * starts it with those tools. The main menu is on every page; the tools find
 * what they work on themselves, also what dialogs and forms add later.
 */
final class PhlairMainMenuBarExtension
  extends PhabricatorMainMenuBarExtension {

  const MAINMENUBARKEY = 'phlair';

  public function buildMainMenus() {
    $viewer = $this->getViewer();
    $tools = PhlairToolSetting::getEnabledTools($viewer);
    if ($tools) {
      // The options of the tools (Option in src/tools.ts).
      $options = array(
        'onedriphe' => OneDripheSetting::isEnabledFor($viewer),
      );
      $config = array('tools' => $tools, 'options' => $options);
      // Phizziwig's libraries for pasted local paths, and the hosts of
      // OneDriphe's links (PhlairConfigOptions).
      if (in_array(PhizziwigSetting::SETTINGKEY, $tools, true)) {
        $config['sharePointFolders'] = (object)PhabricatorEnv::getEnvConfig(
          PhlairConfigOptions::SHAREPOINT_FOLDERS);
        $config['oneDripheHosts'] = PhabricatorEnv::getEnvConfig(
          PhlairConfigOptions::ONEDRIPHE_HOSTS);
      }
      Javelin::initBehavior('phlair', $config, 'phlair');
    }
    return array();
  }

}
