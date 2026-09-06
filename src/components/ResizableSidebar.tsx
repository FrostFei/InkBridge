import { useEffect, useRef, useState, type ReactNode } from 'react';

const storageKey = 'inkbridge.sidebarWidth';
const minimum = 240;
const defaultWidth = 280;

export function ResizableSidebar({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= minimum && saved <= 600) return saved;
    } catch {
      /* Layout preferences are optional. */
    }
    return defaultWidth;
  });
  const [viewport, setViewport] = useState(window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  // Keep room for the note on desktop and a dismissible backdrop on narrow screens.
  const maximum = Math.max(minimum, Math.min(600, viewport - (viewport > 850 ? 420 : 64)));
  const width = Math.min(preferredWidth, maximum);
  const change = (next: number) =>
    setPreferredWidth(Math.round(Math.max(minimum, Math.min(maximum, next))));

  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(storageKey, String(preferredWidth));
    } catch {
      /* Optional. */
    }
  }, [preferredWidth, dragging]);

  return (
    <aside
      id="file-navigation"
      className={`${className} ${dragging ? 'is-resizing' : ''}`}
      style={{ width, minWidth: width }}
    >
      {children}
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label="调整侧栏宽度"
        aria-orientation="vertical"
        aria-controls="file-navigation"
        aria-valuemin={minimum}
        aria-valuemax={maximum}
        aria-valuenow={width}
        aria-valuetext={`${width} 像素`}
        tabIndex={0}
        title="拖动调整宽度，双击恢复默认；方向键也可调整"
        onDoubleClick={() => change(defaultWidth)}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          change(
            event.key === 'Home'
              ? minimum
              : event.key === 'End'
                ? maximum
                : width + (event.key === 'ArrowRight' ? 16 : -16),
          );
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointer: event.pointerId, x: event.clientX, width };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointer === event.pointerId)
            change(drag.current.width + event.clientX - drag.current.x);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointer !== event.pointerId) return;
          drag.current = null;
          setDragging(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
      />
    </aside>
  );
}
