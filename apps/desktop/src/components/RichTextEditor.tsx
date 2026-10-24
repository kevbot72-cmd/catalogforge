import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { AlignCenter, AlignLeft, Bold, Code2, Eraser, Heading2, Heading3, Italic, Link2, List, ListOrdered, Quote, Redo2, Underline as UIcon, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { clsx } from "./ui";

/** Strips Word/Google Docs/supplier-portal junk: inline styles, classes, fonts, spans, comments. */
export function cleanPastedHtml(html: string): string {
  let out = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(o:p|xml|meta|link|style|script|font|w:[^>]*)[^>]*>/gi, "")
    .replace(/\s(class|style|lang|id|align|face|size|color|dir|data-[\w-]+)=("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/<span>\s*<\/span>/gi, "")
    .replace(/<\/?span[^>]*>/gi, "")
    .replace(/<b>/gi, "<strong>")
    .replace(/<\/b>/gi, "</strong>")
    .replace(/<i>/gi, "<em>")
    .replace(/<\/i>/gi, "</em>")
    .replace(/(&nbsp;| )+/g, " ")
    .replace(/<p>\s*<\/p>/gi, "");
  // Google Docs wraps everything in <b id="docs-internal-guid-…">.
  out = out.replace(/<strong>\s*(<(p|h\d|ul|ol)[\s>])/gi, "$1").replace(/(<\/(p|h\d|ul|ol)>)\s*<\/strong>/gi, "$1");
  return out.trim();
}

function Btn({ on, active, title, children }: { on: () => void; active?: boolean; title: string; children: ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={on} className={clsx("rounded p-1.5 hover:bg-sunken", active ? "bg-sunken text-accent" : "text-muted")}>
      {children}
    </button>
  );
}

function Toolbar({ editor, source, setSource }: { editor: Editor; source: boolean; setSource: (v: boolean) => void }) {
  const c = () => editor.chain().focus();
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1">
      <Btn title="Bold" active={editor.isActive("bold")} on={() => c().toggleBold().run()}><Bold size={15} /></Btn>
      <Btn title="Italic" active={editor.isActive("italic")} on={() => c().toggleItalic().run()}><Italic size={15} /></Btn>
      <Btn title="Underline" active={editor.isActive("underline")} on={() => c().toggleUnderline().run()}><UIcon size={15} /></Btn>
      <span className="mx-1 h-4 w-px bg-line" />
      <Btn title="Heading 2" active={editor.isActive("heading", { level: 2 })} on={() => c().toggleHeading({ level: 2 }).run()}><Heading2 size={15} /></Btn>
      <Btn title="Heading 3" active={editor.isActive("heading", { level: 3 })} on={() => c().toggleHeading({ level: 3 }).run()}><Heading3 size={15} /></Btn>
      <Btn title="Bullet list" active={editor.isActive("bulletList")} on={() => c().toggleBulletList().run()}><List size={15} /></Btn>
      <Btn title="Numbered list" active={editor.isActive("orderedList")} on={() => c().toggleOrderedList().run()}><ListOrdered size={15} /></Btn>
      <Btn title="Quote" active={editor.isActive("blockquote")} on={() => c().toggleBlockquote().run()}><Quote size={15} /></Btn>
      <span className="mx-1 h-4 w-px bg-line" />
      <Btn title="Align left" active={editor.isActive({ textAlign: "left" })} on={() => c().setTextAlign("left").run()}><AlignLeft size={15} /></Btn>
      <Btn title="Align center" active={editor.isActive({ textAlign: "center" })} on={() => c().setTextAlign("center").run()}><AlignCenter size={15} /></Btn>
      <Btn
        title="Link"
        active={editor.isActive("link")}
        on={() => {
          const prev = editor.getAttributes("link").href as string | undefined;
          const url = window.prompt("Link URL", prev ?? "https://");
          if (url === null) return;
          if (url === "") c().unsetLink().run();
          else c().extendMarkRange("link").setLink({ href: url }).run();
        }}
      >
        <Link2 size={15} />
      </Btn>
      <Btn title="Clear formatting" on={() => c().unsetAllMarks().clearNodes().run()}><Eraser size={15} /></Btn>
      <span className="flex-1" />
      <Btn title="Undo" on={() => c().undo().run()}><Undo2 size={15} /></Btn>
      <Btn title="Redo" on={() => c().redo().run()}><Redo2 size={15} /></Btn>
      <Btn title="HTML source" active={source} on={() => setSource(!source)}><Code2 size={15} /></Btn>
    </div>
  );
}

export function RichTextEditor({ value, onChange, placeholder, minHeight = 220, testId }: { value: string; onChange: (html: string) => void; placeholder?: string; minHeight?: number; testId?: string }) {
  const [source, setSource] = useState(false);
  const [html, setHtml] = useState(value);
  const last = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const emit = (h: string) => {
    last.current = h;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(h), 350);
  };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3, 4] } }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Placeholder.configure({ placeholder: placeholder ?? "Write something…" }),
    ],
    content: value,
    editorProps: {
      transformPastedHTML: cleanPastedHtml,
      attributes: { class: "prose prose-sm dark:prose-invert max-w-none px-3 py-2", "data-testid": testId ?? "rte" },
    },
    onUpdate: ({ editor }) => {
      const h = editor.isEmpty ? "" : editor.getHTML();
      setHtml(h);
      emit(h);
    },
  });
  // Flush pending edits on unmount so switching tabs never loses typing.
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      onChange(last.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // External value changes (undo, mass change) replace the content.
  useEffect(() => {
    if (editor && value !== last.current) {
      last.current = value;
      setHtml(value);
      editor.commands.setContent(value || "", false);
    }
  }, [value, editor]);
  if (!editor) return null;
  return (
    <div className="overflow-hidden rounded-md border border-line bg-panel focus-within:border-accent">
      <Toolbar editor={editor} source={source} setSource={(v) => {
        if (!v) editor.commands.setContent(html || "", false);
        setSource(v);
      }} />
      {source ? (
        <textarea
          className="block w-full resize-y bg-sunken p-3 font-mono text-xs focus:outline-none"
          style={{ minHeight }}
          value={html}
          spellCheck={false}
          onChange={(e) => {
            setHtml(e.target.value);
            emit(e.target.value);
          }}
        />
      ) : (
        <div style={{ minHeight }} className="max-h-[50vh] overflow-auto">
          <EditorContent editor={editor} />
        </div>
      )}
    </div>
  );
}
