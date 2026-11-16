<?php

/**
 * Links SharePoint's sharing links before the emoji rule sees them. Such a
 * link names the kind of file between colons
 * ("https://x.sharepoint.com/:x:/s/Site/Eab…" for an Excel file), and the
 * emoji rule (priority 200) runs before the hyperlink rule (400): ":x:",
 * ":b:" (PDF), ":v:" (video) and ":o:" (OneNote) became emoji in the URI,
 * which then led nowhere.
 *
 * The links are handed to Phorge's hyperlink rule, as it would find them,
 * and it renders them with the other links of the text (didMarkupText() of
 * the rule the engine has): they look and behave like every other link, also
 * in mail and plain text. Its patterns are applied in its order: "<uri>",
 * "{uri}", then bare URIs. src/phizziwig/inline.ts has the same rule.
 *
 * It applies whether or not a user has Phizziwig on: Phorge caches the
 * rendered text for all viewers.
 */
final class PhizziwigSharePointRemarkupRule
  extends PhabricatorRemarkupCustomInlineRule {

  /** The start of a sharing link, up to its kind of file: "/:x:/". */
  const LINK = 'https?://[A-Za-z0-9-]+\.sharepoint\.com/:[A-Za-z]:/';

  public function getRuleVersion() {
    // Part of the key of Phorge's cache of rendered text: raise it when what
    // the rule renders changes, so texts render again.
    return 1;
  }

  public function getPriority() {
    // After "[[ uri | name ]]" (150) and Phriction's links (175), which
    // store their links first, before the rules of priority 199 and 200.
    return 190.0;
  }

  public function apply($text) {
    $uri = self::LINK.'[^\s'.PhutilRemarkupBlockStorage::MAGIC_BYTE.']';
    $patterns = array(
      '(<'.$uri.'+?>)',
      '({'.$uri.'+?})',
      '((?<!\w)'.$uri.'+)',
    );

    $hyperlinks = id(new PhutilRemarkupHyperlinkRule())
      ->setEngine($this->getEngine());
    $link = function (array $matches) use ($hyperlinks) {
      return $hyperlinks->apply($matches[0]);
    };

    foreach ($patterns as $pattern) {
      $text = preg_replace_callback($pattern, $link, $text);
    }
    return $text;
  }

}
