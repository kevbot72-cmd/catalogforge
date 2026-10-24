import Color from "@tiptap/extension-color";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import TextStyle from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorContent, Extension, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { AlignCenter, AlignLeft, Baseline, Bold, Code2, Eraser, Heading2, Heading3, Italic, Link2, List, ListOrdered, Quote, Redo2, Underline as UIcon, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cleanPastedHtml } from "../lib/pasteHtml";
import { clsx } from "./ui";

export { cleanPastedHtml };

/** Font size as a text-style attribute, written as an inline style WordPress keeps. */
const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el: HTMLElement) => el.style.fontSize || null,
            renderHTML: (attrs: { fontSize?: string | null }) => (attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {}),
          },
        },
      },
    ];
  },
});

const SIZES = ["12px", "14px", "16px", "18px", "20px", "24px", "28px", "32px"];
const SWATCHES = ["#111827", "#6b7280", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#2563eb", "#7c3aed", "#db2777"];

function ColorMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const current = (editor.getAttributes("textStyle").color as string | undefined) ?? "";
  return (
    <div className="relative">
      <button type="button" title="Text colour" aria-label="Text colour" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)} className="flex flex-col items-center rounded px-1.5 pb-0.5 pt-1 text-muted hover:bg-sunken">
        <Baseline size={14} />
        <span className="mt-0.5 h-1 w-4 rounded-sm" style={{ background: current || "currentColor" }} />
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1 w-44 rounded-md border border-line bg-panel p-2 shadow-lg" onMouseLeave={() => setOpen(false)}>
          <div className="grid grid-cols-5 gap-1">
            {SWATCHES.map((c) => (
              <button key={c} type="button" title={c} onMouseDown={(e) => e.preventDefault()} onClick={() => (editor.chain().focus().setColor(c).run(), setOpen(false))} className="h-6 w-6 rounded border border-line" style={{ background: c }} />
            ))}
            <label className="flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-dashed border-line text-2xs text-muted" title="Any colour">
              +
              <input type="color" className="sr-only" onChange={(e) => editor.chain().focus().setColor(e.target.value).run()} />
            </label>
          </div>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => (editor.chain().focus().unsetColor().run(), setOpen(false))} className="mt-2 w-full rounded px-1 py-0.5 text-left text-xs text-muted hover:bg-sunken">Default colour</button>
        </div>
      )}
    </div>
  );
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
      <ColorMenu editor={editor} />
      <select
        title="Text size"
        aria-label="Text size"
        className="h-7 rounded bg-transparent px-1 text-xs text-muted hover:bg-sunken focus:outline-none"
        value={(editor.getAttributes("textStyle").fontSize as string | undefined) ?? ""}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => (e.target.value ? c().setMark("textStyle", { fontSize: e.target.value }).run() : c().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run())}
      >
        <option value="">Size</option>
        {SIZES.map((sz) => <option key={sz} value={sz}>{sz.replace("px", "")}</option>)}
      </select>
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

export function RichTextEditor({ value, onChange, placeholder, minHeight = 220, testId, debounce = 350 }: { value: string; onChange: (html: string) => void; placeholder?: string; minHeight?: number; testId?: string; debounce?: number }) {
  const [source, setSource] = useState(false);
  const [html, setHtml] = useState(value);
  const last = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const emit = (h: string) => {
    last.current = h;
    clearTimeout(timer.current);
    if (!debounce) return onChange(h);
    timer.current = setTimeout(() => onChange(h), debounce);
  };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3, 4] } }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Placeholder.configure({ placeholder: placeholder ?? "Write something…" }),
      TextStyle,
      Color,
      FontSize,
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
