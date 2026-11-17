import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';

interface Props {
  x: number;
  y: number;
  canDelete: boolean;
  onRename(): void;
  onDelete(): void;
  onClose(): void;
}

const EDGE = 8;

export function ListMenu({ x, y, canDelete, onRename, onDelete, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);

  function dismiss() {
    onClose();
    if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
  }

  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    el.style.left = `${Math.max(EDGE, Math.min(x, innerWidth - el.offsetWidth - EDGE))}px`;
    el.style.top = `${Math.max(EDGE, Math.min(y, innerHeight - el.offsetHeight - EDGE))}px`;
    el.querySelector('button')?.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) onClose();
    };
    addEventListener('pointerdown', onPointer, true);
    addEventListener('resize', onClose);
    return () => {
      removeEventListener('pointerdown', onPointer, true);
      removeEventListener('resize', onClose);
    };
  }, [onClose]);

  function onKeyDown(e: KeyboardEvent) {
    const items = Array.from(menu.current?.querySelectorAll('button') ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      // The drawer is a dialog; Escape must close the menu, not the drawer.
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      onClose();
    }
  }

  return (
    <div class="card-menu" role="menu" ref={menu} onKeyDown={onKeyDown}>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        Rename
      </button>
      {canDelete && (
        <button
          type="button"
          role="menuitem"
          class="danger"
          onClick={() => {
            onClose();
            onDelete();
          }}
        >
          Delete
        </button>
      )}
    </div>
  );
}
