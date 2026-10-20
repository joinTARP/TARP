import { UserRound } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";

import { useDocumentPortrait } from "../modules/document-image";
import {
  draftRanges,
  draftText,
  draftMarkdown,
  mentionDraftSchema,
  concatDrafts,
  resolveDraft,
  textDraft,
  filterMentions,
  mentionQuery,
  placeMentionMenu,
  type MentionCandidate,
  type MentionDraft,
} from "./mention";

export interface MentionFieldHandle {
  focus(): void;
  isFocused(): boolean;
  mention(id: string): void;
}

/** 编辑器只允许纯文字和不可拆分的身份标签，序列化始终使用稳定 ID。 */
function readDraft(node: Node): MentionDraft {
  if (node.nodeType === Node.TEXT_NODE)
    return textDraft((node.textContent ?? "").replaceAll("\u200b", ""));
  if (node instanceof HTMLElement) {
    if (node.dataset.mentionId)
      return [
        { type: "mention", id: node.dataset.mentionId, label: (node.textContent ?? "").slice(1) },
      ];
    if (node.tagName === "BR") return textDraft("\n");
  }
  let result: MentionDraft = [];
  for (const child of node.childNodes) {
    const block = child instanceof HTMLElement && /^(DIV|P)$/u.test(child.tagName);
    const before = draftText(result);
    if (block && before && !before.endsWith("\n")) result = concatDrafts(result, textDraft("\n"));
    const body = readDraft(child);
    if (!(block && draftText(body) === "\n" && draftText(result).endsWith("\n")))
      result = concatDrafts(result, body);
  }
  return result;
}
function plain(node: Node) {
  return draftText(readDraft(node));
}
function escape(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function marked(body: MentionDraft) {
  return body
    .map((part) =>
      part.type === "text"
        ? escape(part.text)
        : `<span contenteditable="false" data-mention-id="${escape(part.id)}" class="text-primary bg-primary/8 rounded px-1">@${escape(part.label)}</span>`,
    )
    .join("");
}
function caret(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return plain(root).length;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(root);
  range.setEnd(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
  return plain(range.cloneContents()).length;
}
function selectionOffsets(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return;
  const selected = selection.getRangeAt(0);
  const end = selected.cloneRange();
  end.selectNodeContents(root);
  end.setEnd(selected.endContainer, selected.endOffset);
  return { start: caret(root), end: plain(end.cloneContents()).length };
}
function selectedMarkdownLength(root: HTMLElement) {
  const selection = window.getSelection();
  return selection?.rangeCount && root.contains(selection.anchorNode)
    ? draftMarkdown(readDraft(selection.getRangeAt(0).cloneContents())).length
    : 0;
}
function canInsert(root: HTMLElement, draft: MentionDraft) {
  return (
    draftMarkdown(readDraft(root)).length -
      selectedMarkdownLength(root) +
      draftMarkdown(draft).length <=
    4000
  );
}
function point(root: HTMLElement, index: number): [Node, number] {
  const before = (node: Node) => {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEndBefore(node);
    return plain(range.cloneContents()).length;
  };
  const visit = (node: Node): [Node, number] | undefined => {
    if (node.nodeType === Node.TEXT_NODE) {
      const start = before(node),
        raw = node.textContent ?? "",
        length = plain(node).length;
      if (index >= start && index <= start + length) {
        let offset = 0,
          remaining = index - start;
        while (offset < raw.length && remaining > 0) {
          if (raw[offset] !== "\u200b") remaining--;
          offset++;
        }
        while (raw[offset] === "\u200b") offset++;
        return [node, offset];
      }
      return;
    }
    if (node instanceof HTMLElement && (node.dataset.mentionId || node.tagName === "BR")) {
      const start = before(node),
        end = start + plain(node).length;
      if (index >= start && index <= end)
        return [
          node.parentNode!,
          [...node.parentNode!.childNodes].indexOf(node) + Number(index > start),
        ];
      return;
    }
    for (const child of node.childNodes) {
      const found = visit(child);
      if (found) return found;
    }
  };
  return visit(root) ?? [root, root.childNodes.length];
}
function select(root: HTMLElement, start: number, end = start) {
  const range = document.createRange();
  range.setStart(...point(root, start));
  range.setEnd(...point(root, end));
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
function Portrait({ item }: { item: MentionCandidate }) {
  const portrait = useDocumentPortrait(item.path, item.avatar, item.image);
  return portrait.src ? (
    <img {...portrait} alt="" draggable={false} className="size-full object-cover" />
  ) : (
    <UserRound className="size-3.5" aria-hidden="true" />
  );
}

export const MentionField = forwardRef<
  MentionFieldHandle,
  {
    value: MentionDraft;
    mentions: readonly MentionCandidate[];
    placeholder: string;
    onChange(value: MentionDraft): void;
    onSubmit(): void;
    onToggleMode?(): void;
  }
>(function MentionField({ value, mentions, placeholder, onChange, onSubmit, onToggleMode }, ref) {
  const area = useRef<HTMLDivElement>(null);
  const text = draftText(value);
  const composing = useRef(false);
  const savedSelection = useRef({ start: text.length, end: text.length });
  const breakSequence = useRef(0);
  const [isComposing, setIsComposing] = useState(false);
  const [position, setPosition] = useState(text.length);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const found = mentionQuery(value, position);
  const token = found ? `${found.start}:${found.query}` : null;
  const options = found ? filterMentions(mentions, found.query) : [];
  const open = Boolean(found && options.length && dismissed !== token && !isComposing);
  const current = options[Math.min(active, options.length - 1)];
  const [anchor, setAnchor] = useState({ left: 0, top: 0, above: true });
  const menu = useRef<HTMLUListElement>(null);
  function rememberSelection() {
    const selected = selectionOffsets(area.current!);
    if (selected) {
      savedSelection.current = selected;
      setPosition(selected.start);
    }
  }
  function focusEditor() {
    const root = area.current!;
    if (document.activeElement === root) return;
    const selected = selectionOffsets(root) ?? savedSelection.current;
    root.focus({ preventScroll: true });
    select(root, Math.min(selected.start, text.length), Math.min(selected.end, text.length));
  }
  function sync() {
    const root = area.current!;
    const body = readDraft(root);
    if (draftMarkdown(body).length > 4000) {
      root.innerHTML = marked(value);
      select(root, text.length);
      return;
    }
    rememberSelection();
    setDismissed(null);
    onChange(body);
  }
  function copySelection(event: ClipboardEvent<HTMLDivElement>) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !area.current?.contains(selection.anchorNode)) return false;
    const fragment = selection.getRangeAt(0).cloneContents();
    event.preventDefault();
    const body = readDraft(fragment);
    event.clipboardData.setData("text/plain", draftText(body));
    event.clipboardData.setData("application/x-tarp-mention-draft", JSON.stringify(body));
    return true;
  }
  function insert(target: MentionCandidate, replaceQuery: boolean) {
    const root = area.current!;
    focusEditor();
    const index = caret(root);
    const query = replaceQuery ? mentionQuery(readDraft(root), index) : null;
    if (query) select(root, query.start, index);
    const before = plain(root).slice(0, query?.start ?? index);
    const prefix = !query && before && !/\s$/u.test(before) ? " " : "";
    const inserted = concatDrafts(
      textDraft(prefix),
      [{ type: "mention", id: target.id, label: target.name }],
      textDraft(" "),
    );
    if (!canInsert(root, inserted)) return;
    document.execCommand("insertHTML", false, marked(inserted));
    sync();
  }
  useImperativeHandle(
    ref,
    () => ({
      focus() {
        if (area.current) focusEditor();
      },
      isFocused() {
        return document.activeElement === area.current;
      },
      mention(id) {
        const target = mentions.find((item) => item.id === id);
        if (target) insert(target, true);
      },
    }),
    [mentions, value, onChange],
  );
  useEffect(() => setActive(0), [token]);
  useLayoutEffect(() => {
    const root = area.current!;
    if (composing.current) return;
    if (JSON.stringify(readDraft(root)) !== JSON.stringify(value)) {
      const focused = document.activeElement === root;
      const index = caret(root);
      root.innerHTML = marked(value);
      if (focused) select(root, Math.min(index, text.length));
    }
  }, [value, mentions, isComposing]);
  useLayoutEffect(() => {
    if (!open || !area.current || !menu.current) return;
    const selection = window.getSelection();
    const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    const root = area.current.getBoundingClientRect();
    setAnchor(
      placeMentionMenu(
        {
          left: rect?.left ? rect.left - root.left : 8,
          top: rect?.top ? rect.top - root.top : 0,
          height: 28,
        },
        { width: menu.current.offsetWidth, height: menu.current.offsetHeight },
        root.width,
        root.top,
      ),
    );
  }, [open, value, position, options.length]);
  return (
    <div className="relative">
      {open ? (
        <ul
          ref={menu}
          id="chat-mentions"
          role="listbox"
          aria-label="玩家与队友"
          style={{
            left: anchor.left,
            top: anchor.top,
            transform: anchor.above ? "translateY(calc(-100% - 8px))" : "translateY(4px)",
          }}
          className="border-border bg-popover absolute z-30 max-h-56 w-64 overflow-y-auto rounded-lg border p-1 shadow-lg"
        >
          {options.map((item, index) => (
            <li key={item.id} role="presentation">
              <button
                type="button"
                role="option"
                id={`chat-mention-${item.id}`}
                aria-selected={current?.id === item.id}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => insert(item, true)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${current?.id === item.id ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
              >
                <span className="bg-muted flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full">
                  <Portrait item={item} />
                </span>
                <span className="min-w-0 truncate">{item.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        ref={area}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="聊天内容"
        aria-multiline="true"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? "chat-mentions" : undefined}
        aria-activedescendant={open && current ? `chat-mention-${current.id}` : undefined}
        data-placeholder={placeholder}
        className="text-foreground empty:before:text-muted-foreground max-h-44 min-h-12 overflow-y-auto px-2 pt-1 pb-2 text-[15px] leading-7 break-words whitespace-pre-wrap outline-none empty:before:pointer-events-none empty:before:content-[attr(data-placeholder)]"
        onInput={sync}
        onClick={rememberSelection}
        onSelect={rememberSelection}
        onKeyUp={rememberSelection}
        onCompositionStart={() => {
          composing.current = true;
          setIsComposing(true);
        }}
        onCompositionEnd={() => {
          composing.current = false;
          setIsComposing(false);
          sync();
        }}
        onBlur={() => {
          if (composing.current) {
            composing.current = false;
            setIsComposing(false);
            sync();
          }
        }}
        onCopy={copySelection}
        onCut={(event) => {
          if (copySelection(event)) {
            document.execCommand("delete");
            sync();
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          let body = textDraft(event.clipboardData.getData("text/plain"));
          const identityText = event.clipboardData.getData("application/x-tarp-mention-draft");
          if (identityText) {
            try {
              const parsed = mentionDraftSchema.safeParse(JSON.parse(identityText));
              if (parsed.success) body = resolveDraft(parsed.data, mentions);
            } catch {
              /* 外部剪贴板内容作为普通明文粘贴。 */
            }
          }
          const root = area.current!;
          if (!canInsert(root, body)) return;
          document.execCommand("insertHTML", false, marked(body));
          sync();
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (
            event.key === "Tab" &&
            event.shiftKey &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            if (!event.repeat) onToggleMode?.();
            return;
          }
          if (open && current) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(
                (index) =>
                  (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length,
              );
              return;
            }
            if (
              (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) ||
              (event.key === "Enter" && !event.shiftKey)
            ) {
              event.preventDefault();
              insert(current, true);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDismissed(token);
              return;
            }
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) {
              // Chromium 需要可落脚的换行光标；零宽锚点只留在 DOM，不进入消息或剪贴板。
              const marker = String(++breakSequence.current);
              document.execCommand(
                "insertHTML",
                false,
                `<br><span data-chat-caret="${marker}">\u200b</span>`,
              );
              const anchor = area.current!.querySelector(`[data-chat-caret="${marker}"]`)!;
              const range = document.createRange();
              range.setStart(anchor.firstChild!, 1);
              range.collapse(true);
              const selected = window.getSelection();
              selected?.removeAllRanges();
              selected?.addRange(range);
              sync();
            } else onSubmit();
          }
          if (
            (event.key === "Backspace" || event.key === "Delete") &&
            !event.metaKey &&
            !event.ctrlKey
          ) {
            const selection = window.getSelection();
            if (!selection?.isCollapsed) return;
            const index = caret(area.current!);
            const range = draftRanges(readDraft(area.current!)).find(
              ({ part, start, end }) =>
                part.type === "mention" &&
                (event.key === "Backspace" ? end === index : start === index),
            );
            if (range) {
              event.preventDefault();
              select(area.current!, range.start, range.end);
              document.execCommand("delete");
              sync();
            }
          }
        }}
      />
    </div>
  );
});
