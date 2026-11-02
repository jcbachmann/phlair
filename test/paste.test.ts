// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { htmlToRemarkup, shouldConvertHtml, tsvToRemarkup } from "../src/phizziwig/paste";

// Clipboard HTML saved from the applications (trimmed, see the files).
const fixture = (name: string) => readFileSync(`${import.meta.dirname}/fixtures/paste/${name}.html`, "utf8");

const lines = (...l: string[]) => l.join("\n");

describe("htmlToRemarkup: sources", () => {
  it("converts a web page copied in Chrome, ignoring the computed styles it inlines", () => {
    const html =
      `<meta charset='utf-8'><h2 style="box-sizing: border-box; margin-top: 24px; margin-bottom: 16px; font-size: 1.5em; font-weight: 600; ` +
      `line-height: 1.25; color: rgb(31, 35, 40); font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, &quot;Noto Sans&quot;, ` +
      `Helvetica, Arial, sans-serif; font-style: normal; background-color: rgb(255, 255, 255);">Installation</h2>` +
      `<p style="box-sizing: border-box; margin-top: 0px; color: rgb(31, 35, 40); font-family: -apple-system, BlinkMacSystemFont, ` +
      `&quot;Segoe UI&quot;, sans-serif; font-size: 16px; font-style: normal; font-weight: 400; background-color: rgb(255, 255, 255);">` +
      `Run<span>&nbsp;</span><code style="box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, &quot;SF Mono&quot;, Menlo, ` +
      `Consolas, monospace; font-size: 13.6px; padding: 0.2em 0.4em; background-color: rgba(129, 139, 152, 0.12); border-radius: 6px;">` +
      `npm install</code><span>&nbsp;</span>and read the<span>&nbsp;</span><a href="https://github.com/example/project/blob/main/README.md" ` +
      `style="box-sizing: border-box; color: rgb(9, 105, 218); text-decoration: underline;">README</a>.</p>` +
      `<br class="Apple-interchange-newline">`;
    expect(htmlToRemarkup(html)).toBe(
      lines(
        "= Installation",
        "",
        "Run `npm install` and read the [[ https://github.com/example/project/blob/main/README.md | README ]].",
      ),
    );
  });

  it("converts a Word document: lists from mso-list paragraphs, highlight, monospace font, table", () => {
    expect(htmlToRemarkup(fixture("word"))).toBe(
      lines(
        "= Measurement report",
        "",
        "The sample was measured with **40 kV** and //no filter//. See [[ https://phorge.example.com/T123 | the task ]] for " +
          "details. Run `make install` first.",
        "",
        "  - Iron",
        "    - K-alpha !!6.40 keV!!",
        "  - Copper",
        "",
        "Steps:",
        "",
        "  # Calibrate",
        "  # Measure",
        "",
        "| **Element** | **Concentration** |",
        "| Fe          | 12.5 % (± 0.2)    |",
      ),
    );
  });

  it("converts Google Docs without making everything bold from its <b> wrapper", () => {
    expect(htmlToRemarkup(fixture("google-docs"))).toBe(
      lines(
        "= Calibration notes",
        "",
        "Use the **new** standard, //not// the __old__ one. !!Check daily.!!",
        "",
        "  - Warm up the tube",
        "    - at least `30 min`",
        "  - [[ https://docs.google.com/document/d/1abc/edit#heading=h.x1 | Measure the standard ]]",
        "",
        "| Line  | Energy       |",
        "| Fe Kα | **6.40 keV** |",
      ),
    );
  });

  it("converts Google Docs checklists", () => {
    const html =
      `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-0a1b2c3d-7fff-1234-5678-9abcdef01234">` +
      `<ul style="margin-top:0;margin-bottom:0;padding-inline-start:28px;">` +
      `<li dir="ltr" role="checkbox" aria-checked="true" style="list-style-type:none;font-size:11pt;font-weight:400;" aria-level="1">` +
      `<img src="data:image/png;base64,iVBORw0KGgo=" width="17.6px" height="17.6px" alt="checked" aria-roledescription="checkbox" ` +
      `style="margin-right:3px;" aria-hidden="true"><p dir="ltr" style="line-height:1.38;" role="presentation">` +
      `<span style="font-size:11pt;font-weight:400;text-decoration:line-through;">Order the standard</span></p></li>` +
      `<li dir="ltr" role="checkbox" aria-checked="false" style="list-style-type:none;font-size:11pt;font-weight:400;" aria-level="1">` +
      `<img src="data:image/png;base64,iVBORw0KGgo=" width="17.6px" height="17.6px" alt="unchecked" aria-roledescription="checkbox" ` +
      `style="margin-right:3px;" aria-hidden="true"><p dir="ltr" style="line-height:1.38;" role="presentation">` +
      `<span style="font-size:11pt;font-weight:400;">Calibrate</span></p></li></ul></b>`;
    expect(htmlToRemarkup(html)).toBe(lines("  - [X] ~~Order the standard~~", "  - [ ] Calibrate"));
  });

  it("converts an Excel range into a table, with line breaks in cells as spaces", () => {
    expect(htmlToRemarkup(fixture("excel"))).toBe(
      lines(
        "| Sample | Fe   | Cu   | Note      |",
        "| S-001  | 12.5 | 0.03 | first run |",
        "| S-002  | 11.9 |      | A¦B       |",
      ),
    );
  });

  it("converts LibreOffice Writer HTML with <font face> and background highlights", () => {
    const html =
      `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN"><html><head>` +
      `<meta http-equiv="content-type" content="text/html; charset=utf-8"/><title></title>` +
      `<meta name="generator" content="LibreOffice 24.2.4.2 (Linux)"/><style type="text/css">@page { size: 21cm 29.7cm; ` +
      `margin: 2cm } p { line-height: 115%; margin-bottom: 0.25cm; background: transparent }</style></head>` +
      `<body lang="de-CH" link="#000080" vlink="#800000" dir="ltr"><h1 class="western">Results</h1>\n` +
      `<p style="line-height: 100%; margin-bottom: 0cm">The <b>iron</b> content is <span style="background: #ffff00">too\n` +
      `high</span>.</p>\n<ol>\n\t<li><p style="line-height: 100%; margin-bottom: 0cm">Repeat</p>\n\t` +
      `<li><p style="line-height: 100%; margin-bottom: 0cm"><font face="Liberation Mono, monospace">make test</font></p>\n</ol>\n` +
      `</body></html>`;
    expect(htmlToRemarkup(html)).toBe(
      lines("= Results", "", "The **iron** content is !!too high!!.", "", "  # Repeat", "  # `make test`"),
    );
  });

  it("converts a Confluence page: header row of th in tbody, colspan, code panel, lozenge", () => {
    const html =
      `<meta charset='utf-8'><p>Status: <span class="status-macro aui-lozenge aui-lozenge-success">DONE</span></p>` +
      `<div class="table-wrap"><table class="confluenceTable"><colgroup><col><col></colgroup><tbody>` +
      `<tr><th class="confluenceTh"><p>Mode</p></th><th class="confluenceTh"><p>Database</p></th></tr>` +
      `<tr><td class="confluenceTd"><p>Black | Magenta</p></td><td class="confluenceTd"><p><code>app</code></p></td></tr>` +
      `<tr><td class="confluenceTd" colspan="2"><p>Remote: <a href="https://wiki.example.com/x/Remote">setup</a></p></td></tr>` +
      `</tbody></table></div>` +
      `<div class="code panel pdl" style="border-width: 1px;"><div class="codeContent panelContent pdl">` +
      `<pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: bash; gutter: false; theme: Confluence" ` +
      `data-theme="Confluence">uv sync\nmake install</pre></div></div>`;
    expect(htmlToRemarkup(html)).toBe(
      lines(
        "Status: DONE",
        "",
        "| Mode                           | Database |",
        "| ------------------------------ | -------- |",
        "| Black ¦ Magenta                | `app`    |",
        "| Remote: [[ https://wiki.example.com/x/Remote | setup ]] |          |",
        "",
        "```",
        "uv sync",
        "make install",
        "```",
      ),
    );
  });
});

describe("htmlToRemarkup: blocks", () => {
  it("maps heading levels to the level Phorge renders, h1 like h2", () => {
    const html = "<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F <b>bold</b></h6>";
    expect(htmlToRemarkup(html)).toBe(
      lines("= A", "", "= B", "", "== C", "", "=== D", "", "==== E", "", "===== F bold"),
    );
  });

  it("keeps italic in headings but not the bold a heading has anyway", () => {
    expect(htmlToRemarkup('<h3><span style="font-weight:700">Results</span> for <em>Fe</em></h3>')).toBe(
      "== Results for //Fe//",
    );
  });

  it("converts nested lists with paragraphs in items", () => {
    const html = `<ul>
      <li>Fruits
        <ul>
          <li>Apple</li>
          <li>Banana with <strong>bold <em>and italic</em></strong> text</li>
        </ul>
      </li>
      <li>Steps
        <ol>
          <li><p>First</p></li>
          <li><p>Second</p><p>continued</p></li>
        </ol>
      </li>
    </ul>`;
    expect(htmlToRemarkup(html)).toBe(
      lines(
        "  - Fruits",
        "    - Apple",
        "    - Banana with **bold //and italic//** text",
        "  - Steps",
        "    # First",
        "    # Second continued",
      ),
    );
  });

  it("does not leave an indentation gap for items that only hold a list", () => {
    expect(htmlToRemarkup("<ul><li><ul><li>Inner</li></ul></li><li>Outer</li></ul>")).toBe(
      lines("  - Inner", "  - Outer"),
    );
  });

  it("converts task lists with checkbox inputs", () => {
    const html =
      `<ul class="contains-task-list"><li class="task-list-item enabled"><input type="checkbox" ` +
      `class="task-list-item-checkbox" checked=""> Calibrate detector</li><li class="task-list-item enabled">` +
      `<input type="checkbox" class="task-list-item-checkbox"> Measure samples<ul><li>with <a href="https://x.test/">notes</a></li>` +
      `</ul></li></ul>`;
    expect(htmlToRemarkup(html)).toBe(
      lines("  - [X] Calibrate detector", "  - [ ] Measure samples", "    - with [[ https://x.test/ | notes ]]"),
    );
  });

  it("indents list items: a lone '# item' line at the start of a line is a header", () => {
    expect(htmlToRemarkup("<ol><li>Only</li></ol><p>Next</p>")).toBe(lines("  # Only", "", "Next"));
  });

  it("keeps pre text exactly in a fenced block", () => {
    const html =
      '<pre class="highlight"><code><span class="k">def</span> <span class="nf">f</span>(x):\n' +
      '    <span class="k">return</span> x  <span class="c"># two  spaces</span>\n\n' +
      "\tindented&nbsp;tab<br>after br\n</code></pre>";
    expect(htmlToRemarkup(html)).toBe(
      lines("```", "def f(x):", "    return x  # two  spaces", "", "\tindented tab", "after br", "```"),
    );
  });

  it("prefixes quotes, also nested ones and their paragraphs", () => {
    const html =
      "<blockquote><p>First paragraph.</p><p>Second <b>one</b>.</p><blockquote><p>Nested</p></blockquote></blockquote>";
    expect(htmlToRemarkup(html)).toBe(lines("> First paragraph.", ">", "> Second **one**.", ">", "> > Nested"));
  });

  it("converts rules and keeps only the alt text of images", () => {
    const html = '<p>Before</p><hr><p><img src="https://x.test/y.png" alt="Spectrum plot"> <img src="z.png"></p>';
    expect(htmlToRemarkup(html)).toBe(lines("Before", "", "---", "", "Spectrum plot"));
  });

  it("separates divs and paragraphs by one blank line and keeps line breaks", () => {
    const html = "<div><div>One</div><div>Two<br>still two</div></div><p>Three</p>";
    expect(htmlToRemarkup(html)).toBe(lines("One", "", "Two", "still two", "", "Three"));
  });

  it("collapses whitespace like a browser and drops empty paragraphs", () => {
    const html =
      "<div>\n  <p>  Lots   of\n   space </p>\n\n<p></p><p>&nbsp;</p>\n<div>Line<br><br><br><br>after breaks<br></div></div>";
    expect(htmlToRemarkup(html)).toBe(lines("Lots of space", "", "Line", "", "after breaks"));
  });

  it("converts a table with thead, inline formatting and line breaks in cells", () => {
    const html =
      "<table><thead><tr><th>Element</th><th>Line</th><th>Energy (keV)</th></tr></thead><tbody>" +
      "<tr><td>Fe</td><td>K<sub>α</sub></td><td><code>6.40</code></td></tr>" +
      "<tr><td>Cu</td><td>K<sub>β</sub></td><td><em>8.90</em><br>approx.</td></tr></tbody></table>";
    expect(htmlToRemarkup(html)).toBe(
      lines(
        "| Element | Line | Energy (keV)     |",
        "| ------- | ---- | ---------------- |",
        "| Fe      | Kα   | `6.40`           |",
        "| Cu      | Kβ   | //8.90// approx. |",
      ),
    );
  });

  it("keeps bold th cells outside of header rows", () => {
    const html = "<table><tr><th>Fe</th><td>12.5</td></tr><tr><th>Cu</th><td>0.03</td></tr></table>";
    expect(htmlToRemarkup(html)).toBe(lines("| **Fe** | 12.5 |", "| **Cu** | 0.03 |"));
  });

  it("unwraps single-column layout tables", () => {
    expect(htmlToRemarkup("<table><tr><td><p>Hello</p><p>World</p></td></tr><tr><td>Bye</td></tr></table>")).toBe(
      lines("Hello", "", "World", "", "Bye"),
    );
  });

  it("skips scripts, styles, hidden elements and comments", () => {
    const html =
      "<style>p { color: red }</style><script>alert(1)</script><!--[if gte mso 9]><xml><o:x>no</o:x></xml><![endif]-->" +
      '<p>Visible<span style="display:none">hidden</span><span hidden>also hidden</span></p>';
    expect(htmlToRemarkup(html)).toBe("Visible");
  });
});

describe("htmlToRemarkup: inline formatting", () => {
  it("converts tags", () => {
    const html =
      "<p><u>u</u> <s>s</s>, <del>d</del>, <strike>st</strike> <mark>m</mark> <kbd>Ctrl</kbd>+<tt>C</tt> <i>i</i> <b>b</b></p>";
    expect(htmlToRemarkup(html)).toBe("__u__ ~~s~~, ~~d~~, ~~st~~ !!m!! `Ctrl`+`C` //i// **b**");
  });

  it("converts CSS styles", () => {
    const html =
      '<p><span style="font-weight: bold">b</span>, <span style="font-weight:600">b6</span>, ' +
      '<span style="font-weight:500">n</span> <span style="font-style: italic">i</span> ' +
      '<span style="text-decoration: underline">u</span> <span style="text-decoration-line: line-through">s</span> ' +
      '<span style="font-family: &quot;Courier New&quot;, monospace">c</span> ' +
      '<span style="font-family: Arial, monospace">not code</span></p>';
    expect(htmlToRemarkup(html)).toBe("**b**, **b6**, n //i// __u__ ~~s~~ `c` not code");
  });

  it("nests combined formatting", () => {
    expect(htmlToRemarkup("<p><b>bold <i>both</i></b><i> italic</i></p>")).toBe("**bold //both//** //italic//");
    expect(htmlToRemarkup("<p><b><i><u>all</u></i></b></p>")).toBe("**//__all__//**");
    expect(htmlToRemarkup("<p><b>bold <code>code</code></b></p>")).toBe("**bold `code`**");
  });

  it("puts markers around the text, not around its surrounding spaces", () => {
    expect(htmlToRemarkup("<p>a<b> b </b>c<i> </i>d<s></s>e</p>")).toBe("a **b** c de");
  });

  it("merges adjacent runs of the same formatting", () => {
    expect(htmlToRemarkup('<p><b>one</b><b> two</b> <span style="font-weight:700">three</span></p>')).toBe(
      "**one two three**",
    );
  });

  it("lets inline styles turn bold off inside bold", () => {
    expect(htmlToRemarkup('<p><strong>Note:<span style="font-weight:normal"> not bold</span> bold</strong></p>')).toBe(
      "**Note:** not bold **bold**",
    );
  });

  it("closes markers at line breaks", () => {
    expect(htmlToRemarkup("<p><b>line one<br>line two</b></p>")).toBe(lines("**line one**", "**line two**"));
  });

  it("highlights with light saturated backgrounds of inline elements only", () => {
    const html =
      '<p><span style="background-color: rgb(255, 255, 0)">yellow</span> ' +
      '<span style="background-color: #fff2cc">light</span> ' +
      '<span style="background-color: rgb(255, 255, 255)">white</span> ' +
      '<span style="background-color: rgb(30, 30, 30)">dark</span> ' +
      '<span style="background-color: rgba(255, 255, 0, 0.1)">faint</span> ' +
      '<span style="background-color: #ffff00"><span style="background-color: transparent">inherits</span></span></p>' +
      '<div style="background-color: #ffff00">panel</div>';
    expect(htmlToRemarkup(html)).toBe(lines("!!yellow light!! white dark faint !!inherits!!", "", "panel"));
  });

  it("does not take the underline of links as formatting", () => {
    expect(htmlToRemarkup('<p><a href="https://x.test/a" style="text-decoration: underline">a</a></p>')).toBe(
      "[[ https://x.test/a | a ]]",
    );
  });
});

describe("htmlToRemarkup: links", () => {
  it("writes the bare URL when the text is the URL", () => {
    expect(htmlToRemarkup('<p>See <a href="https://x.test/page">https://x.test/page</a>.</p>')).toBe(
      "See https://x.test/page.",
    );
  });

  it("uses brackets for URLs next to formatting markers and for relative links", () => {
    expect(
      htmlToRemarkup('<p><b><a href="https://x.test/">https://x.test/</a></b> <a href="/w/page/">/w/page/</a></p>'),
    ).toBe("**[[ https://x.test/ ]]** [[ /w/page/ ]]");
  });

  it("keeps mailto links and drops javascript and in-page links", () => {
    const html =
      '<p><a href="mailto:info@example.com">info@example.com</a> <a href=" JavaScript:alert(1)">click</a> ' +
      '<a href="#_Toc123">Introduction</a> <a name="top">anchor</a></p>';
    expect(htmlToRemarkup(html)).toBe("[[ mailto:info@example.com | info@example.com ]] click Introduction anchor");
  });

  it("uses the plain text of the link, the alt text of images, or the URL", () => {
    const html =
      '<p><a href="https://x.test/a b"><b>Bold</b>  <i>name</i></a> <a href="https://x.test/"><img src="l.png" alt="Logo"></a> ' +
      '<a href="https://x.test/empty"></a></p>';
    expect(htmlToRemarkup(html)).toBe(
      "[[ https://x.test/a%20b | Bold name ]] [[ https://x.test/ | Logo ]] https://x.test/empty",
    );
  });

  it("keeps the image instead of the link of a linked image that becomes an image (Wikipedia)", () => {
    const html =
      '<figure typeof="mw:File/Thumb"><a href="https://en.wikipedia.org/wiki/File:Fe.jpg" class="mw-file-description">' +
      '<img src="https://upload.wikimedia.org/fe.jpg" alt=""></a><figcaption>Iron</figcaption></figure>' +
      '<p>See <a href="https://x.test/"><img src="https://x.test/no.png" alt="Logo"></a>.</p>';
    const images = (src: string) => (src.includes("wikimedia") ? `{IMG ${src}}` : null);
    expect(htmlToRemarkup(html, images)).toBe(
      "{IMG https://upload.wikimedia.org/fe.jpg}\n\nIron\n\nSee [[ https://x.test/ | Logo ]].",
    );
  });
});

describe("tsvToRemarkup", () => {
  it("converts cells copied from a spreadsheet, first row as header", () => {
    expect(tsvToRemarkup("Sample\tFe\tCu\r\nS-001\t12.5\t0.03\r\nS-002\t11.9\t\r\n")).toBe(
      lines(
        "| Sample | Fe   | Cu   |",
        "| ------ | ---- | ---- |",
        "| S-001  | 12.5 | 0.03 |",
        "| S-002  | 11.9 |      |",
      ),
    );
  });

  it("reads quoted cells with line breaks, tabs and quotes, and replaces pipes", () => {
    expect(tsvToRemarkup('Name\tNote\nFe\t"first\nsecond ""run"""\nCu\t"a\tb | c"')).toBe(
      lines(
        "| Name | Note               |",
        "| ---- | ------------------ |",
        '| Fe   | first second "run" |',
        "| Cu   | a b ¦ c            |",
      ),
    );
  });

  it("allows extra empty cells at the end of rows", () => {
    expect(tsvToRemarkup("a\tb\t\t\nc\td")).toBe(lines("| a   | b   |", "| --- | --- |", "| c   | d   |"));
  });

  it("converts a single row without a header", () => {
    expect(tsvToRemarkup("Fe\t12.5")).toBe("| Fe  | 12.5 |");
  });

  it("returns null for text that is not a range of cells", () => {
    expect(tsvToRemarkup("just text")).toBeNull();
    expect(tsvToRemarkup("one\ntwo\nthree")).toBeNull();
    expect(tsvToRemarkup("")).toBeNull();
    // Code indented with tabs.
    expect(tsvToRemarkup("if (x) {\n\treturn 1;\n}")).toBeNull();
    expect(tsvToRemarkup("\tfoo();\n\tbar();")).toBeNull();
    // A line with fewer cells, or an empty line, between rows.
    expect(tsvToRemarkup("a\tb\tc\nd\te")).toBeNull();
    expect(tsvToRemarkup("a\tb\n\nc\td")).toBeNull();
  });
});

describe("shouldConvertHtml", () => {
  it("keeps plain text when the HTML is a plain run of text", () => {
    const html =
      '<meta charset="utf-8"><span style="color: rgb(204, 204, 204); font-family: Inter, sans-serif; font-size: 14px; ' +
      'background-color: rgb(30, 30, 30);">Text on a  dark page</span>';
    expect(shouldConvertHtml(html, "Text on a  dark page")).toBe(false);
  });

  it("converts formatting, structure and paragraphs the text would join", () => {
    expect(shouldConvertHtml("<p>Some <b>bold</b> text</p>", "Some bold text")).toBe(true);
    expect(shouldConvertHtml("<ul><li>a</li><li>b</li></ul>", "a\nb")).toBe(true);
    expect(shouldConvertHtml("<p>a</p><p>b</p>", "a\nb")).toBe(true);
    expect(shouldConvertHtml("<p>a</p><p>b</p>", "a\n\nb")).toBe(false);
    expect(shouldConvertHtml(fixture("excel"), "Sample\tFe\tCu\tNote\n")).toBe(true);
    expect(shouldConvertHtml(fixture("google-docs"), "Calibration notes")).toBe(true);
  });

  it("keeps the plain text of code from code editors and pre blocks", () => {
    const vscode =
      `<meta charset='utf-8'><div style="color: #cccccc;background-color: #1f1f1f;font-family: Consolas, 'Courier New', ` +
      `monospace;font-weight: normal;font-size: 14px;line-height: 19px;white-space: pre;"><div><span style="color: #569cd6;">` +
      `const</span><span style="color: #cccccc;"> </span><span style="color: #4fc1ff;">x</span><span style="color: #cccccc;"> = ` +
      `</span><span style="color: #b5cea8;">1</span><span style="color: #cccccc;">;</span></div><br><div>` +
      `<span style="color: #cccccc;">x</span></div></div>`;
    expect(shouldConvertHtml(vscode, "const x = 1;\n\nx")).toBe(false);
    const jetbrains =
      `<html><head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head><body>` +
      `<pre style="background-color:#1e1f22;color:#bcbec4;font-family:'JetBrains Mono',monospace;font-size:9,8pt;">` +
      `<span style="color:#cf8e6d;">def </span><span style="color:#56a8f5;">f</span>():<br>    ` +
      `<span style="color:#cf8e6d;">pass</span></pre></body></html>`;
    expect(shouldConvertHtml(jetbrains, "def f():\n    pass")).toBe(false);
    // CodeMirror lines selected and copied by the browser.
    const codemirror =
      '<div class="cm-line" style="font-family: Inter, sans-serif;">= Title =</div><div class="cm-line">- item</div>';
    expect(shouldConvertHtml(codemirror, "= Title\n- item")).toBe(false);
    expect(shouldConvertHtml("<code>npm install</code>", "npm install")).toBe(false);
  });

  it("keeps the plain text when the HTML converts to nothing", () => {
    expect(shouldConvertHtml("", "text")).toBe(false);
    expect(shouldConvertHtml('<img src="https://x.test/a.png">', "")).toBe(false);
  });
});
