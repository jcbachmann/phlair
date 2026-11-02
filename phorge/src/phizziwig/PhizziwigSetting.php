<?php

final class PhizziwigSetting extends PhlairToolSetting {

  const SETTINGKEY = 'phizziwig';

  public function getSettingName() {
    return pht('Phizziwig: Remarkup Editor');
  }

  protected function getControlInstructions() {
    return pht(
      'Phizziwig shows remarkup text fields (descriptions, comments, wiki '.
      'pages) as they render while you edit them: only the part you are '.
      'editing shows its remarkup. Its wand button in the toolbar switches '.
      'to the plain text field for the page you are on.');
  }

  public function getSettingDefaultValue() {
    return self::VALUE_DISABLED;
  }

}
