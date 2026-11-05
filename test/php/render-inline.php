<?php

// Reads a JSON list of texts from stdin and prints the HTML Phorge's remarkup
// engine renders for each, as a single paragraph: [{text, html}, ...]. Used by
// scripts/generate-inline-fixtures.mjs to compare the inline rules of
// src/phizziwig/inline.ts with the real ones.
//
// The texts are rendered by the paragraph block rule alone, so that every
// text is one block whatever it starts with (a "- " or "= " would otherwise
// make a list or a header). The engine is the one Phorge renders remarkup
// fields with, with all inline rules of the installed applications.
//
// The viewer is alice, a normal user (dev/phorge/seed.php): references render
// as a user sees them, and every seeded object is visible to her.

require_once '/srv/phorge/scripts/init/init-script.php';

$texts = phutil_json_decode(file_get_contents('php://stdin'));

$viewer = id(new PhabricatorPeopleQuery())
  ->setViewer(PhabricatorUser::getOmnipotentUser())
  ->withUsernames(array('alice'))
  ->needUserSettings(true)
  ->executeOne();
if (!$viewer) {
  throw new Exception('The dev instance has no user "alice"; run the seed.');
}

$engine = PhabricatorMarkupEngine::newMarkupEngine(array());
$engine->setConfig('viewer', $viewer);
$engine->setConfig('uri.base', PhabricatorEnv::getURI('/'));

$paragraph = null;
foreach (get_private($engine, 'blockRules') as $rule) {
  if ($rule instanceof PhutilRemarkupDefaultBlockRule) {
    $paragraph = $rule;
  }
}

$result = array();
foreach ($texts as $text) {
  // What PhutilRemarkupEngine::preprocessText() does, for one block: the
  // storage and metadata of one text must not leak into the next.
  set_private($engine, 'metadata', array());
  set_private($engine, 'storage', new PhutilRemarkupBlockStorage());
  try {
    $output = $paragraph->markupText($text, null);
  } catch (Exception $ex) {
    // A rule that throws (e.g. on rendering a broken reference) makes the
    // whole text unusable as a fixture.
    continue;
  }
  $storage = get_private($engine, 'storage');
  $html = $engine->postprocessText(array(
    'output' => $output,
    'storage' => $storage->getMap(),
    'metadata' => get_private($engine, 'metadata'),
  ));
  $result[] = array('text' => $text, 'html' => (string)$html);
}

echo phutil_json_encode($result);

function get_private($object, $name) {
  $property = new ReflectionProperty(get_class($object), $name);
  $property->setAccessible(true);
  return $property->getValue($object);
}

function set_private($object, $name, $value) {
  $property = new ReflectionProperty(get_class($object), $name);
  $property->setAccessible(true);
  $property->setValue($object, $value);
}
