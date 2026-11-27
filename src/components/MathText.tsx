import React, { useEffect, useMemo, useState } from 'react';

interface MathTextProps {
  text: string;
  className?: string;
}

type Segment =
  | { type: 'text'; value: string }
  | { type: 'inline-math'; value: string }
  | { type: 'block-math'; value: string };

type KatexModule = typeof import('katex').default;

let cachedKatex: KatexModule | null = null;
let katexLoadPromise: Promise<KatexModule> | null = null;

function loadKatexAsync(): Promise<KatexModule> {
  if (cachedKatex) return Promise.resolve(cachedKatex);
  if (!katexLoadPromise) {
    katexLoadPromise = Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ]).then(([mod]) => {
      cachedKatex = mod.default;
      return cachedKatex;
    });
  }
  return katexLoadPromise;
}

function tokenizeLatex(input: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: input.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      segments.push({ type: 'block-math', value: match[1] });
    } else if (match[2] !== undefined) {
      segments.push({ type: 'inline-math', value: match[2] });
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < input.length) {
    segments.push({ type: 'text', value: input.slice(lastIndex) });
  }

  return segments;
}

export const MathText: React.FC<MathTextProps> = ({ text, className = '' }) => {
  const safeText = text || '';
  const hasMathSyntax = safeText.includes('$');
  const [katexLib, setKatexLib] = useState<KatexModule | null>(() => cachedKatex);

  const segments = useMemo(
    () => (hasMathSyntax ? tokenizeLatex(safeText) : null),
    [safeText, hasMathSyntax]
  );

  const hasMathSegments = useMemo(
    () => Boolean(segments && segments.some((seg) => seg.type !== 'text')),
    [segments]
  );

  useEffect(() => {
    if (!hasMathSegments || katexLib) return;
    let active = true;
    void loadKatexAsync()
      .then((mod) => {
        if (active) setKatexLib(() => mod);
      })
      .catch(() => {
        // Keep raw text fallback if dynamic chunk fails offline
      });
    return () => {
      active = false;
    };
  }, [hasMathSegments, katexLib]);

  const renderedSegments = useMemo(() => {
    if (!segments) return null;
    return segments.map((seg) => {
      if (seg.type === 'text') {
        return { type: 'text' as const, value: seg.value };
      }
      const displayMode = seg.type === 'block-math';
      if (!katexLib) {
        return {
          type: 'text' as const,
          value: displayMode ? `$$${seg.value}$$` : `$${seg.value}$`,
        };
      }
      const html = katexLib.renderToString(seg.value, {
        displayMode,
        throwOnError: false,
        strict: false,
      });
      return {
        type: seg.type,
        html,
      };
    });
  }, [segments, katexLib]);

  if (!hasMathSyntax || !renderedSegments) {
    return <span className={className}>{safeText}</span>;
  }

  return (
    <span className={className}>
      {renderedSegments.map((seg, idx) => {
        if (seg.type === 'text') {
          return <React.Fragment key={idx}>{seg.value}</React.Fragment>;
        }
        return seg.type === 'block-math' ? (
          <span
            key={idx}
            className="block my-2 overflow-x-auto"
            dangerouslySetInnerHTML={{ __html: seg.html }}
          />
        ) : (
          <span key={idx} dangerouslySetInnerHTML={{ __html: seg.html }} />
        );
      })}
    </span>
  );
};
