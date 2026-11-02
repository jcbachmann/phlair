<?php

final class PhutureSetting extends PhlairToolSetting {

  const SETTINGKEY = 'phuture';

  public function getSettingName() {
    return pht('Phuture: Snooze');
  }

  protected function getControlInstructions() {
    return pht(
      'Phuture adds a clock button to the items of lists (dashboards, '.
      'searches, workboards): it snoozes the item, which is then hidden on '.
      'every list until the day you choose. The clock in the main menu shows '.
      'snoozed items again. Snoozes are kept in your browser.');
  }

  public function getSettingDefaultValue() {
    return self::VALUE_DISABLED;
  }

}
