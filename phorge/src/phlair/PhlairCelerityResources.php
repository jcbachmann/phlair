<?php

/**
 * Phlair's script, rsrc/phlair.js (built by build.mjs, with its map in
 * resources/celerity/map.php).
 */
final class PhlairCelerityResources extends CelerityResourcesOnDisk {

  public function getName() {
    return 'phlair';
  }

  public function getPathToResources() {
    return $this->getLibraryPath('rsrc/');
  }

  public function getPathToMap() {
    return $this->getLibraryPath('resources/celerity/map.php');
  }

  private function getLibraryPath($to_file) {
    return dirname(phutil_get_library_root('phlair')).'/'.$to_file;
  }

}
