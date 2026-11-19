import React, { useMemo } from 'react';
import { marked } from 'marked';
import readme from '../../../README.md?raw';
import architecture from '../../../docs/architecture.md?raw';
import guardrails from '../../../docs/guardrails.md?raw';
import streams from '../../../docs/streams.md?raw';

/** The repo's own markdown, bundled at build time. The repository is private, so a GitHub link would 404 for anyone else. */
export const DOCS = [
  { slug: 'readme', label: 'README', source: readme },
  { slug: 'architecture', label: 'Architecture', source: architecture },
  { slug: 'guardrails', label: 'Guardrails', source: guardrails },
  { slug: 'streams', label: 'Streams', source: streams },
] as const;
export type DocSlug = (typeof DOCS)[number]['slug'];
export function isDocSlug(value: string): value is DocSlug { return DOCS.some(d => d.slug === value); }
export function docHref(slug: DocSlug): string { return `#/docs/${slug}`; }

/** Relative links between the bundled files become in-app routes; anything else is left alone. */
function rewrite(href: string): string {
  const m = /^(?:\.\/)?(?:docs\/)?([a-z]+)\.md$/i.exec(href);
  if (!m) return href;
  const slug = m[1]!.toLowerCase();
  return isDocSlug(slug) ? docHref(slug) : href;
}
const ARCH_SVG = `<svg viewBox="0 0 760 220" class="arch-svg" role="img" aria-label="Delphi architecture flow">
  <defs>
    <marker id="arch-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,1 L7,4 L0,7 Z" fill="var(--accent)" />
    </marker>
  </defs>
  <g fill="none" stroke="var(--line2)" stroke-width="1.4" marker-end="url(#arch-arrow)">
    <path d="M100,24 V10 H660 V24" />
    <path d="M188,56 H292" />
    <path d="M100,88 V136" />
    <path d="M188,154 H240 V72 H292" stroke="var(--accent)" />
    <path d="M188,176 H292" />
    <path d="M380,88 V136" stroke="var(--accent)" />
    <path d="M572,72 H520 V154 H468" stroke="var(--accent)" />
    <path d="M468,176 H572" />
    <path d="M468,44 H536 V112 H660 V136" />
  </g>
  <g font-family="var(--mono)" font-size="8.5" fill="var(--muted)" text-anchor="middle">
    <text x="380" y="8">settled outcomes</text>
    <text x="240" y="49">quotes · orders</text>
    <text x="106" y="116" text-anchor="start">market data</text>
    <text x="234" y="116" text-anchor="end" fill="var(--accent)">x402 reads</text>
    <text x="240" y="169">commit hash</text>
    <text x="373" y="116" text-anchor="end" fill="var(--accent)">record_purchase</text>
    <text x="514" y="125" text-anchor="end" fill="var(--accent)">resolve · forfeit</text>
    <text x="520" y="169">program logs</text>
    <text x="665" y="124" text-anchor="start">telemetry</text>
  </g>
  <g fill="var(--panel2)" stroke="var(--line2)" stroke-width="1.2">
    <rect x="12" y="24" width="176" height="64" rx="6" />
    <rect x="12" y="136" width="176" height="64" rx="6" />
    <rect x="292" y="24" width="176" height="64" rx="6" stroke="var(--accent)" />
    <rect x="292" y="136" width="176" height="64" rx="6" stroke="var(--accent)" />
    <rect x="572" y="24" width="176" height="64" rx="6" />
    <rect x="572" y="136" width="176" height="64" rx="6" />
  </g>
  <g font-family="var(--mono)" text-anchor="middle">
    <text x="100" y="51" fill="#fff" font-size="11" font-weight="600">Gemini Markets</text>
    <text x="100" y="69" fill="var(--muted)" font-size="9">events · quotes · settlement</text>
    <text x="100" y="163" fill="#fff" font-size="11" font-weight="600">Forecaster (3 personas)</text>
    <text x="100" y="181" fill="var(--muted)" font-size="9">quant · momentum · contrarian</text>
    <text x="380" y="51" fill="var(--accent)" font-size="11" font-weight="600">Buyer Agent + Voice</text>
    <text x="380" y="69" fill="var(--muted)" font-size="9">x402 reads · pool · ElevenLabs</text>
    <text x="380" y="163" fill="var(--accent)" font-size="11" font-weight="600">Delphi Program (Solana)</text>
    <text x="380" y="181" fill="var(--muted)" font-size="9">commit · purchase · score · rep</text>
    <text x="660" y="51" fill="#fff" font-size="11" font-weight="600">Resolver (oracle + forfeit)</text>
    <text x="660" y="69" fill="var(--muted)" font-size="9">settle · reveal · forfeit</text>
    <text x="660" y="163" fill="#fff" font-size="11" font-weight="600">Streams → Indexer → Web</text>
    <text x="660" y="181" fill="var(--muted)" font-size="9">QuickNode · SQLite · SSE</text>
  </g>
</svg>`;
const renderer = new marked.Renderer();
const link = renderer.link.bind(renderer);
const code = renderer.code.bind(renderer);
renderer.link = token => link({ ...token, href: rewrite(token.href) });
renderer.code = ({ text, lang }) => lang === 'mermaid' ? ARCH_SVG : code({ type: 'code', raw: text, text, lang });
export function Docs({ slug }: { slug: DocSlug }) {
  const doc = DOCS.find(d => d.slug === slug) ?? DOCS[0];
  // Trusted content: our own repository files, not user input.
  const html = useMemo(() => marked.parse(doc.source, { async: false, gfm: true, renderer }), [doc]);
  return <div className="docs">
    <nav className="doc-nav" aria-label="Documentation">{DOCS.map(d => <a key={d.slug} href={docHref(d.slug)} aria-current={d.slug === doc.slug ? 'page' : undefined}>{d.label}</a>)}</nav>
    <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />
  </div>;
}
