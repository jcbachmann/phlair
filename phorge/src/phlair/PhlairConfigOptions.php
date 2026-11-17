<?php

/**
 * Phlair's options in Config: the SharePoint libraries that users' computers
 * sync or mount, by the names of their local folders, so that Phizziwig makes
 * links to SharePoint of local paths pasted alone
 * (src/phizziwig/localPaths.ts); and the SharePoint hosts whose links offer
 * OneDriphe (src/phizziwig/sharePointLinks.ts). PhlairMainMenuBarExtension
 * passes them to the script.
 */
final class PhlairConfigOptions extends PhabricatorApplicationConfigOptions {

  const SHAREPOINT_FOLDERS = 'phlair.sharepoint-folders';
  const ONEDRIPHE_HOSTS = 'phlair.onedriphe-hosts';

  /** A host of SharePoint: of a tenant's sites, or its OneDrives ("-my"). */
  const HOST = '(^[a-z0-9-]+\.sharepoint\.com$)D';

  public function getKey() {
    return 'phlair';
  }

  public function getName() {
    return pht('Phlair');
  }

  public function getDescription() {
    return pht('Configure the tools of Phlair.');
  }

  public function getIcon() {
    return 'fa-magic';
  }

  public function getGroup() {
    return 'apps';
  }

  public function getApplicationClassName() {
    return PhlairApplication::class;
  }

  public function getOptions() {
    $example = array(
      'https://contoso.sharepoint.com/sites/Projects/Shared%20Documents' =>
        array('Projects - Documents', 'OneDrive - Contoso/Documents'),
    );
    return array(
      $this->newOption(self::SHAREPOINT_FOLDERS, 'wild', array())
        ->setSummary(
          pht('SharePoint libraries, by the names of their local folders.'))
        ->setDescription(
          pht(
            "Phizziwig makes a link to SharePoint of a local path pasted ".
            "alone (as Explorer copies it: ".
            "`C:\\Users\\me\\OneDrive - Contoso\\Projects - Documents\\Plans`".
            "), if a folder of it is one of these libraries. Each library's ".
            "URL comes with the names its folder has on users' computers: ".
            "the folder of a synced library or of a shortcut in OneDrive ".
            "(\"Add shortcut to My files\"), or where rclone mounts it. A ".
            "name may include folders above it (\"OneDrive - Contoso/".
            "Documents\"), for one that is not unique by itself. Other paths ".
            "stay as pasted. The list is part of the pages of users who have ".
            "Phizziwig on."))
        ->addExample(
          phutil_json_encode($example),
          pht('A library, with two names of its folder')),
      $this->newOption(self::ONEDRIPHE_HOSTS, 'list<string>', array())
        ->setSummary(
          pht('SharePoint hosts whose links offer OneDriphe.'))
        ->setDescription(
          pht(
            "With OneDriphe, the menu of a SharePoint link offers \"In ".
            "Explorer\" (Linux: \"In the file manager\"), which works where ".
            "the library is synced. Where these are set, only links to these ".
            "hosts offer it, e.g. the sites of the company's tenant and their ".
            "OneDrives, not the links of others' tenants. Empty: links to any ".
            "host."))
        ->addExample(
          "contoso.sharepoint.com\ncontoso-my.sharepoint.com",
          pht('The sites and OneDrives of a tenant')),
    );
  }

  protected function didValidateOption(
    PhabricatorConfigOption $option,
    $value) {
    if ($option->getKey() === self::ONEDRIPHE_HOSTS) {
      foreach ($value as $host) {
        if (!preg_match(self::HOST, $host)) {
          throw new PhabricatorConfigValidationException(
            pht('"%s" is not a host of SharePoint.', $host));
        }
      }
    }
    if ($option->getKey() !== self::SHAREPOINT_FOLDERS) {
      return;
    }
    if (!is_array($value)) {
      throw new PhabricatorConfigValidationException(
        pht(
          '"%s" must be a map of URLs to lists of names.',
          $option->getKey()));
    }
    // Each name once: a path must lead to one library.
    $seen = array();
    foreach ($value as $url => $names) {
      if (!preg_match('(^https://[a-z0-9-]+\.sharepoint\.com/\S+$)Di', $url)) {
        throw new PhabricatorConfigValidationException(
          pht('"%s" is not the https URL of a SharePoint library.', $url));
      }
      if (!is_array($names) || !$names || !phutil_is_natural_list($names)) {
        throw new PhabricatorConfigValidationException(
          pht('The names of "%s" must be a list of folder names.', $url));
      }
      foreach ($names as $name) {
        $parts = is_string($name) ?
          array_filter(preg_split('([\\\\/]+)', $name), 'strlen') :
          array();
        if (!$parts || array_intersect($parts, array('.', '..'))) {
          throw new PhabricatorConfigValidationException(
            pht('A name of "%s" is not the name of a folder.', $url));
        }
        $key = phutil_utf8_strtolower(implode('/', $parts));
        if (isset($seen[$key])) {
          throw new PhabricatorConfigValidationException(
            pht('"%s" is the name of more than one library.', $name));
        }
        $seen[$key] = true;
      }
    }
  }

}
