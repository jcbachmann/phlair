<?php

/**
 * The settings of Phlair's tools (PhlairToolSetting), for users and in
 * Global Default Settings, where the administrator sets the defaults.
 */
final class PhlairSettingsPanel
  extends PhabricatorEditEngineSettingsPanel {

  const PANELKEY = 'phlair';

  public function getPanelName() {
    return pht('Phlair');
  }

  public function getPanelMenuIcon() {
    return 'fa-magic';
  }

  public function getPanelGroupKey() {
    return PhabricatorSettingsApplicationsPanelGroup::PANELGROUPKEY;
  }

  public function isTemplatePanel() {
    return true;
  }

}
