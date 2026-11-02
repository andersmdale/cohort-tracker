import { useState } from 'react';

/** Copies text; falls back to selecting nothing silently when the clipboard is unavailable. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('ok');
    } catch {
      setState('fail');
    }
    setTimeout(() => setState('idle'), 1500);
  };
  return (
    <button className="btn sm" type="button" title={text} onClick={copy}>
      {state === 'ok' ? 'Copied' : state === 'fail' ? 'Select & copy' : label}
    </button>
  );
}
