import React, { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

interface MathTextProps {
  text: string;
  className?: string;
}

type Segment =
  | { type: 'text'; value: string }
  | { type: 'inline-math'; value: string }
  | { type: 'block-math'; value: string };

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
  const segments = useMemo(() => tokenizeLatex(text || ''), [text]);

  return (
    <span className={className}>
      {segments.map((seg, idx) => {
        if (seg.type === 'text') {
          return <React.Fragment key={idx}>{seg.value}</React.Fragment>;
        }
        const displayMode = seg.type === 'block-math';
        const html = katex.renderToString(seg.value, {
          displayMode,
          throwOnError: false,
          strict: false,
        });
        return displayMode ? (
          <span
            key={idx}
            className="block my-2 overflow-x-auto"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <span key={idx} dangerouslySetInnerHTML={{ __html: html }} />
        );
      })}
    </span>
  );
};
