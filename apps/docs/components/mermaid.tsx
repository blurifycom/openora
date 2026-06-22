'use client';
import { useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';
import { TransformWrapper, TransformComponent, useControls } from 'react-zoom-pan-pinch';

function Controls() {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  return (
    <div className="mermaid-controls">
      <button type="button" onClick={() => zoomIn()} aria-label="Zoom in">
        +
      </button>
      <button type="button" onClick={() => zoomOut()} aria-label="Zoom out">
        −
      </button>
      <button type="button" onClick={() => resetTransform()} aria-label="Reset view">
        Reset
      </button>
    </div>
  );
}

/** Renders a Mermaid diagram with the official renderer, theme-aware, in a pan/zoom viewport. */
export function Mermaid({ chart }: { chart: string }) {
  const rawId = useId();
  const id = `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          theme: resolvedTheme === 'dark' ? 'dark' : 'default',
          fontFamily: 'var(--font-sans-doc), system-ui, sans-serif',
        });
        const { svg: rendered } = await mermaid.render(id, chart);
        if (active) {
          setSvg(rendered);
          setFailed(false);
        }
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [chart, id, resolvedTheme]);

  if (failed) {
    return (
      <figure className="mermaid-figure">
        <pre className="mermaid-fallback">{chart}</pre>
      </figure>
    );
  }

  if (!svg) {
    return <figure className="mermaid-figure mermaid-loading">Rendering diagram…</figure>;
  }

  return (
    <figure className="mermaid-figure">
      <TransformWrapper
        minScale={0.3}
        maxScale={5}
        initialScale={2.8}
        centerOnInit
        limitToBounds={false}
        wheel={{ step: 0.12 }}
        doubleClick={{ mode: 'reset' }}
      >
        <Controls />
        <TransformComponent wrapperClass="mermaid-viewport" contentClass="mermaid-content">
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        </TransformComponent>
      </TransformWrapper>
    </figure>
  );
}
