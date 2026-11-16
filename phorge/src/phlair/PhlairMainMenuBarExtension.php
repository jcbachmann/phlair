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
      Javelin::initBehavior(
        'phlair',
        array('tools' => $tools, 'options' => $options),
        'phlair');
    }
    return array();
  }

}
