import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import { renderMermaidSVG } from 'beautiful-mermaid';

/** Drops the root <svg> width/height attributes so CSS can size the diagram responsively.
 * The inline `style` is kept - it carries the theme CSS-variable definitions the nodes use. */
function makeResponsive(svg: string): string {
  return svg.replace(/<svg([^>]*)>/, (_match, attrs: string) => {
    const cleaned = attrs.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '');
    return `<svg${cleaned}>`;
  });
}

/** Renders a Mermaid diagram to SVG at build time; falls back to a code block on parse errors. */
export async function Mermaid({ chart }: { chart: string }) {
  try {
    const svg = renderMermaidSVG(chart, {
      bg: 'var(--color-fd-background)',
      fg: 'var(--color-fd-foreground)',
      interactive: false,
      transparent: true,
    });

    return (
      <figure
        className="mermaid-figure"
        dangerouslySetInnerHTML={{ __html: makeResponsive(svg) }}
      />
    );
  } catch {
    return (
      <CodeBlock title="Mermaid">
        <Pre>{chart}</Pre>
      </CodeBlock>
    );
  }
}
