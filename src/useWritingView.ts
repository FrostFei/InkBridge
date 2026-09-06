import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror';

export type WritingMode = 'edit' | 'split' | 'read';
type Pane = 'edit' | 'read';
const storageKey = 'inkbridge.writingView';
const narrowQuery = '(max-width: 850px)';

function readPreference(): { mode: WritingMode; lastPane: Pane } {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (['edit', 'split', 'read'].includes(value?.mode)) {
      return { mode: value.mode, lastPane: value.lastPane === 'read' ? 'read' : 'edit' };
    }
  } catch {
    /* View preferences must never prevent opening a note. */
  }
  return { mode: 'split', lastPane: 'edit' };
}

export function useWritingView(noteKey: string) {
  const [preference, setPreference] = useState(readPreference);
  const [narrow, setNarrow] = useState(() => matchMedia(narrowQuery).matches);
  const mode = narrow && preference.mode === 'split' ? preference.lastPane : preference.mode;
  const editor = useRef<ReactCodeMirrorRef>(null);
  const preview = useRef<HTMLDivElement>(null);
  const position = useRef({ key: noteKey, edit: 0, read: 0 });
  const keyboardFocus = useRef(false);

  const rememberScroll = useCallback(() => {
    if (position.current.key !== noteKey) return;
    const edit = editor.current?.view?.scrollDOM;
    if (edit?.getClientRects().length) position.current.edit = edit.scrollTop;
    if (preview.current?.getClientRects().length) position.current.read = preview.current.scrollTop;
  }, [noteKey]);

  useEffect(() => {
    const media = matchMedia(narrowQuery);
    const resize = () => {
      rememberScroll();
      setNarrow(media.matches);
    };
    media.addEventListener('change', resize);
    resize();
    return () => media.removeEventListener('change', resize);
  }, [rememberScroll]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(preference));
    } catch {
      /* Optional. */
    }
  }, [preference]);

  useLayoutEffect(() => {
    if (position.current.key !== noteKey) position.current = { key: noteKey, edit: 0, read: 0 };
    const saved = { ...position.current };
    if (preview.current && mode !== 'edit') preview.current.scrollTop = saved.read;
    // CodeMirror measures its viewport after a hidden editor becomes visible.
    // Restore after that measurement so it doesn't scroll back to the cursor.
    const view = editor.current?.view;
    if (view && mode !== 'read') {
      if (keyboardFocus.current) view.focus();
      view.requestMeasure({
        key: position,
        read: () => saved.edit,
        write: (top) => {
          if (position.current.key === saved.key && view.scrollDOM.getClientRects().length)
            view.scrollDOM.scrollTop = top;
        },
      });
    }
    keyboardFocus.current = false;
  }, [mode, noteKey]);

  const choose = (next: WritingMode, fromKeyboard = false) => {
    rememberScroll();
    keyboardFocus.current = fromKeyboard && next === 'edit';
    if (next === mode && keyboardFocus.current) {
      editor.current?.view?.focus();
      keyboardFocus.current = false;
    }
    setPreference((current) => ({
      mode: narrow && current.mode === 'split' ? 'split' : next,
      lastPane: next === 'split' ? current.lastPane : next,
    }));
  };

  const markActive = (pane: Pane) => {
    // In split view, rotation follows the pane the user actually interacted with.
    if (mode === 'split')
      setPreference((current) =>
        current.lastPane === pane ? current : { ...current, lastPane: pane },
      );
  };

  return { mode, narrow, choose, markActive, editor, preview };
}
