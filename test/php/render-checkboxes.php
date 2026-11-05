<?php

// Reads a JSON list of texts from stdin and prints, for each, the checkboxes
// Phorge's remarkup engine renders: true for checked ones, false for the
// others, in their order. Used by scripts/generate-checkmark-fixtures.mjs.

require_once '/srv/phorge/scripts/init/init-script.php';

$texts = phutil_json_decode(file_get_contents('php://stdin'));
$viewer = PhabricatorUser::getOmnipotentUser();

$result = array();
foreach ($texts as $text) {
  $engine = PhabricatorMarkupEngine::newMarkupEngine(array());
  $engine->setConfig('viewer', $viewer);
  $html = (string)$engine->markupText($text);
  preg_match_all('/<input type="checkbox"[^>]*>/', $html, $matches);
  $boxes = array();
  foreach ($matches[0] as $input) {
    $boxes[] = (strpos($input, 'checked') !== false);
  }
  $result[] = array('text' => $text, 'checkboxes' => $boxes);
}

echo phutil_json_encode($result);
