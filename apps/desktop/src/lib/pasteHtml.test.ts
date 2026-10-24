// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { cleanPastedHtml } from "./pasteHtml";

describe("pasted HTML", () => {
  it("keeps bullets, bold, colour and size from a web page or editor", () => {
    const html = `<p style="font-size:14px;color:#333">Intro with <b>bold</b> and <span style="color:#e11d48">red</span> and <span style="font-size:20px">big</span> words.</p><ul><li>One</li><li><strong>Two</strong></li></ul>`;
    expect(cleanPastedHtml(html)).toBe(`<p>Intro with <strong>bold</strong> and <span style="color: #e11d48">red</span> and <span style="font-size: 20px">big</span> words.</p><ul><li>One</li><li><strong>Two</strong></li></ul>`);
  });

  it("reads Google Docs styling (bold in spans, base size and colour dropped)", () => {
    const html = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:700;">Warm</span><span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:400;"> and dry, </span><span style="font-size:11pt;color:#ff0000;font-style:italic;">limited</span><span style="font-size:11pt;color:#000000;"> stock.</span></p><ul><li dir="ltr"><p dir="ltr"><span style="font-size:11pt;color:#000000;">Wool</span></p></li></ul></b>`;
    expect(cleanPastedHtml(html)).toBe(`<p><strong>Warm</strong> and dry, <em><span style="color: #ff0000">limited</span></em> stock.</p><ul><li><p>Wool</p></li></ul>`);
  });

  it("turns Word's fake lists into real ones and strips Office markup", () => {
    const html = `<p class="MsoNormal"><span style="font-size:12.0pt;font-family:Calibri;mso-fareast-font-family:Calibri">Features<o:p></o:p></span></p>
<p class="MsoListParagraphCxSpFirst" style="text-indent:-18.0pt;mso-list:l0 level1 lfo1"><![if !supportLists]><span style="font-family:Symbol;mso-list:Ignore">·<span style="font:7.0pt">&nbsp;&nbsp; </span></span><![endif]><span style="font-size:12.0pt">Waterproof<o:p></o:p></span></p>
<p class="MsoListParagraphCxSpLast" style="text-indent:-18.0pt;mso-list:l0 level1 lfo1"><![if !supportLists]><span style="font-family:Symbol;mso-list:Ignore">·<span style="font:7.0pt">&nbsp;&nbsp; </span></span><![endif]><b><span style="font-size:12.0pt;color:#C00000">Lifetime</span></b><span style="font-size:12.0pt"> warranty<o:p></o:p></span></p>`;
    expect(cleanPastedHtml(html)).toBe(`<p>Features</p> <ul><li>Waterproof</li><li><strong><span style="color: #C00000">Lifetime</span></strong> warranty</li></ul>`);
  });

  it("removes scripts and javascript links", () => {
    expect(cleanPastedHtml(`<p>Hi<script>var pasted = 1;</script> <a href="javascript:alert(1)">x</a> <a href="https://a.example">y</a></p>`)).toBe(`<p>Hi <a>x</a> <a href="https://a.example">y</a></p>`);
  });
});
