<?php

/**
 * Stores an image of another site, for the images of pasted text: the page
 * may not fetch it itself (Phorge's Content-Security-Policy allows no
 * other sites). The server fetches it like its image proxy does
 * (PhabricatorFileImageProxyController): within "security.outbound-blacklist"
 * and rate limited.
 */
final class PhizziwigDownloadConduitAPIMethod extends ConduitAPIMethod {

  public function getAPIMethodName() {
    return 'phizziwig.download';
  }

  public function getMethodDescription() {
    return pht(
      'Download an image from a URL and store it as a file, like an image '.
      'pasted into a remarkup field.');
  }

  public function getMethodStatus() {
    return self::METHOD_STATUS_UNSTABLE;
  }

  protected function defineParamTypes() {
    return array(
      'uri' => 'required string',
      'name' => 'optional string',
    );
  }

  protected function defineReturnType() {
    return 'map<string, wild>';
  }

  protected function defineErrorTypes() {
    return array(
      'ERR-DISABLED' => pht('Phizziwig is not on for you.'),
      'ERR-NOT-IMAGE' => pht('The URL is not an image.'),
    );
  }

  protected function execute(ConduitAPIRequest $request) {
    $viewer = $request->getUser();

    if (!PhizziwigSetting::isEnabledFor($viewer)) {
      throw new ConduitException('ERR-DISABLED');
    }

    $params = array(
      'authorPHID' => $viewer->getPHID(),
      'isExplicitUpload' => true,
    );
    $name = $request->getValue('name');
    if (phutil_nonempty_string($name)) {
      $params['name'] = $name;
    }

    // Like Phorge's own fetches for users: less useful for scanning networks
    // and ports, or for filling the file storage.
    PhabricatorSystemActionEngine::willTakeAction(
      array($viewer->getPHID()),
      new PhabricatorFilesOutboundRequestAction(),
      1);

    $file = PhabricatorFile::newFromFileDownload(
      $request->getValue('uri'),
      $params);

    if (!$file->isViewableImage()) {
      id(new PhabricatorDestructionEngine())->destroyObject($file);
      throw new ConduitException('ERR-NOT-IMAGE');
    }

    return array(
      'id' => (int)$file->getID(),
      'phid' => $file->getPHID(),
    );
  }

}
