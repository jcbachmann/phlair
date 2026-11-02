<?php

// Reads a JSON list of texts from stdin and prints how Phorge's remarkup
// engine splits each into top-level blocks: [[start line, line count], ...].
// The engine's own test inputs are appended to the list. Used by
// scripts/generate-block-fixtures.mjs.

require_once '/srv/phorge/scripts/init/init-script.php';

$texts = phutil_json_decode(file_get_contents('php://stdin'));

// Phorge does not ship these test inputs.
$fixtures = '/srv/phorge/src/infrastructure/markup/remarkup/__tests__/remarkup';
$names = Filesystem::pathExists($fixtures) ? Filesystem::listDirectory($fixtures) : array();
foreach ($names as $name) {
  $parts = explode("\n~~~~~~~~~~\n", Filesystem::readFile($fixtures.'/'.$name));
  $texts[] = $parts[0];
}

$engine = PhabricatorMarkupEngine::newMarkupEngine(array());
$split = new ReflectionMethod($engine, 'splitTextIntoBlocks');
$split->setAccessible(true);

$result = array();
foreach ($texts as $text) {
  // Phorge's engine throws on some inputs, e.g. an unterminated "name {{{".
  try {
    $split_blocks = $split->invoke($engine, $text);
  } catch (Exception $ex) {
    continue;
  }
  $blocks = array();
  foreach ($split_blocks as $block) {
    $blocks[] = array($block['start'], $block['num_lines']);
  }
  $result[] = array('text' => $text, 'blocks' => $blocks);
}

echo phutil_json_encode($result);
