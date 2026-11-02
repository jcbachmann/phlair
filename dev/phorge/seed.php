<?php

// Creates the "admin" user and demo content once. Runs on every container
// start and does nothing when the content already exists.

require_once '/srv/phorge/scripts/init/init-script.php';

$omnipotent = PhabricatorUser::getOmnipotentUser();

$admin = id(new PhabricatorPeopleQuery())
  ->setViewer($omnipotent)
  ->withUsernames(array('admin'))
  ->needUserSettings(true)
  ->executeOne();
if ($admin) {
  // Content added to the seed later.
  seed_macro($admin);
  seed_phlair($admin);
  echo "Seed: already done.\n";
  exit(0);
}

$admin = id(new PhabricatorUser())
  ->setUsername('admin')
  ->setRealName('Admin User')
  ->setIsApproved(1);
$email = id(new PhabricatorUserEmail())
  ->setAddress('admin@example.test')
  ->setIsVerified(1);
id(new PhabricatorUserEditor())
  ->setActor($admin)
  ->createNewUser($admin, $email);
$admin->setIsAdmin(1)->save();

$alice = id(new PhabricatorUser())
  ->setUsername('alice')
  ->setRealName('Alice Example')
  ->setIsApproved(1);
id(new PhabricatorUserEditor())
  ->setActor($admin)
  ->createNewUser(
    $alice,
    id(new PhabricatorUserEmail())
      ->setAddress('alice@example.test')
      ->setIsVerified(1));

// Conduit calls need a fully loaded viewer.
$admin = id(new PhabricatorPeopleQuery())
  ->setViewer($omnipotent)
  ->withUsernames(array('admin'))
  ->needUserSettings(true)
  ->executeOne();

// An image macro "rmecat", for memes ({meme, src=rmecat, above=..., below=...}).
function seed_macro($admin) {
  $existing = id(new PhabricatorMacroQuery())
    ->setViewer(PhabricatorUser::getOmnipotentUser())
    ->withNames(array('rmecat'))
    ->executeOne();
  if ($existing) {
    return;
  }
  $image = imagecreatetruecolor(240, 180);
  imagefill($image, 0, 0, imagecolorallocate($image, 200, 140, 60));
  ob_start();
  imagepng($image);
  $file = PhabricatorFile::newFromFileData(
    ob_get_clean(),
    array(
      'name' => 'rmecat.png',
      'authorPHID' => $admin->getPHID(),
      'canCDN' => true,
    ));
  $xactions = array(
    id(new PhabricatorMacroTransaction())
      ->setTransactionType(PhabricatorMacroNameTransaction::TRANSACTIONTYPE)
      ->setNewValue('rmecat'),
    id(new PhabricatorMacroTransaction())
      ->setTransactionType(PhabricatorMacroFileTransaction::TRANSACTIONTYPE)
      ->setNewValue($file->getPHID()),
  );
  id(new PhabricatorMacroEditor())
    ->setActor($admin)
    ->setContentSource(PhabricatorContentSource::newForSource(PhabricatorConsoleContentSource::SOURCECONST))
    ->applyTransactions(PhabricatorFileImageMacro::initializeNewFileImageMacro($admin), $xactions);
  echo "Seed: created the image macro rmecat.\n";
}

// Phizziwig off in the Global Default Settings (as by default, also after a
// test that changes them failed): most E2E tests inject the userscript. On
// for alice, whose session the tests of the installed library use.
function seed_phlair($admin) {
  $global = PhabricatorUserPreferences::loadGlobalPreferences($admin);
  if (!$global->getBuiltinKey()) {
    $global->setBuiltinKey(PhabricatorUserPreferences::BUILTIN_GLOBAL_DEFAULT);
  }
  seed_setting($admin, $global, PhizziwigSetting::SETTINGKEY, PhlairToolSetting::VALUE_DISABLED);

  $alice = id(new PhabricatorPeopleQuery())
    ->setViewer(PhabricatorUser::getOmnipotentUser())
    ->withUsernames(array('alice'))
    ->executeOne();
  seed_setting(
    $alice,
    PhabricatorUserPreferences::loadUserPreferences($alice),
    PhizziwigSetting::SETTINGKEY,
    PhlairToolSetting::VALUE_ENABLED);
}

function seed_setting($actor, $preferences, $key, $value) {
  if ($preferences->getPreference($key) === $value) {
    return;
  }
  id(new PhabricatorUserPreferencesEditor())
    ->setActor($actor)
    ->setContentSource(PhabricatorContentSource::newForSource(PhabricatorConsoleContentSource::SOURCECONST))
    ->setContinueOnNoEffect(true)
    ->applyTransactions($preferences, array($preferences->newTransaction($key, $value)));
  echo "Seed: $key \"$value\" for ".($preferences->getBuiltinKey() ? 'everyone' : $actor->getUsername()).".\n";
}

function seed_call($user, $method, array $params) {
  $call = new ConduitCall($method, $params);
  $call->setUser($user);
  return $call->execute();
}

// A small image so {F1} has something to show.
$image = imagecreatetruecolor(160, 90);
imagefill($image, 0, 0, imagecolorallocate($image, 70, 120, 200));
imagestring($image, 5, 20, 35, 'Demo image', imagecolorallocate($image, 255, 255, 255));
ob_start();
imagepng($image);
$png = ob_get_clean();
$file = PhabricatorFile::newFromFileData(
  $png,
  array(
    'name' => 'demo.png',
    'authorPHID' => $admin->getPHID(),
    'viewPolicy' => PhabricatorPolicies::POLICY_USER,
  ));
$file_monogram = 'F'.$file->getID();

$task = seed_call($admin, 'maniphest.createtask', array(
  'title' => 'Calibrate the detector',
  'description' => 'Something to link to.',
));
$closed = seed_call($admin, 'maniphest.createtask', array(
  'title' => 'An already closed task',
  'description' => 'Closed tasks render struck through.',
));
seed_call($admin, 'maniphest.edit', array(
  'objectIdentifier' => $closed['phid'],
  'transactions' => array(array('type' => 'status', 'value' => 'resolved')),
));
seed_call($admin, 'project.edit', array(
  'transactions' => array(array('type' => 'name', 'value' => 'Demo Project')),
));

$task_monogram = 'T'.$task['id'];
$closed_monogram = 'T'.$closed['id'];

seed_call($admin, 'phriction.create', array(
  'slug' => '/',
  'title' => 'Wiki Home',
  'content' => "See [[ demo/ ]] for every remarkup construct.",
));

$demo = <<<EOT
= Remarkup demo =

This page uses **bold**, //italic//, `monospaced`, ~~deleted~~, !!highlighted!! and __underlined__ text.
It links to $task_monogram, $closed_monogram, {{$task_monogram}}, @alice, [[ /w/ | the wiki home ]] and [[ https://example.com | an external site ]].

== Notes and quotes ==

NOTE: This is a note.

IMPORTANT: This is important.

WARNING: This is a warning.

(NOTE) A note without the word shown.

> Quoted text
> continues here.

>>! In $task_monogram, @alice wrote:
> A reply quote.

== Lists ==

- First item
- Second item
  - Nested item
- [ ] Open checkbox
- [X] Done checkbox

# Numbered
# Items

== Table ==

| Element | Line | Energy (keV)
|---------|------|-------------
| Fe | Ka | 6.40
| Cu | Ka | 8.05
| Zn | Ka | 8.64

== Code ==

```lang=python
def hello():
    return "world"
```

  indented code
  block

== Image ==

{{$file_monogram}}

---

%%%Literal **not bold** text%%%
EOT;

seed_call($admin, 'phriction.create', array(
  'slug' => 'demo/',
  'title' => 'Remarkup Demo',
  'content' => $demo,
));

seed_macro($admin);
seed_phlair($admin);

echo "Seed: created admin, alice, $task_monogram, $closed_monogram, $file_monogram, wiki pages.\n";
