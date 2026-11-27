import React, { useMemo } from 'react';
import katex from 'katex';

interface MathTextProps {
  text: string;
  className?: string;
}

type Segment =
  | { type: 'text'; value: string }
  | { type: 'inline-math'; value: string }
  | { type: 'block-math'; value: string };

const ARABIC_CHAR_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN_CHAR_REGEX = /[A-Za-z]/;
const ARABIC_RUN_REGEX =
  /([\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+(?:[\s\u060C\u061B\u061F\u0640\u0660-\u0669\u06F0-\u06F9«»()،؛؟۝۞.,:!-]*[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+)*)/g;

export function containsArabicScript(value: string): boolean {
  return ARABIC_CHAR_REGEX.test(value || '');
}

function isArabicDominantLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !ARABIC_CHAR_REGEX.test(trimmed)) return false;
  // Cek karakter huruf pertama (abaikan angka/tanda baca awal)
  for (const ch of trimmed) {
    if (ARABIC_CHAR_REGEX.test(ch)) return true;
    if (LATIN_CHAR_REGEX.test(ch)) return false;
  }
  return true;
}

/**
 * Memecah teks campuran menjadi segmen teks biasa, rumus inline ($...$ atau \(...\)),
 * dan rumus block ($$...$$ atau \[...\]).
 */
function parseMathSegments(input: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        value: input.slice(lastIndex, match.index),
      });
    }

    if (match[1] !== undefined) {
      segments.push({ type: 'block-math', value: match[1].trim() });
    } else if (match[2] !== undefined) {
      segments.push({ type: 'block-math', value: match[2].trim() });
    } else if (match[3] !== undefined) {
      segments.push({ type: 'inline-math', value: match[3].trim() });
    } else if (match[4] !== undefined) {
      segments.push({ type: 'inline-math', value: match[4].trim() });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < input.length) {
    segments.push({
      type: 'text',
      value: input.slice(lastIndex),
    });
  }

  return segments;
}

function renderTextWithArabicRuns(text: string, keyPrefix: string, isLineArabic: boolean): React.ReactNode {
  if (!text) return null;
  if (!ARABIC_CHAR_REGEX.test(text)) {
    return <React.Fragment key={keyPrefix}>{text}</React.Fragment>;
  }

  if (isLineArabic) {
    return (
      <span key={keyPrefix} lang="ar" className="font-arabic text-[1.2em] leading-[2.05]">
        {text}
      </span>
    );
  }

  const parts = text.split(ARABIC_RUN_REGEX);
  return (
    <React.Fragment key={keyPrefix}>
      {parts.map((part, idx) => {
        if (!part) return null;
        if (ARABIC_CHAR_REGEX.test(part)) {
          return (
            <span
              key={`${keyPrefix}-ar-${idx}`}
              dir="rtl"
              lang="ar"
              className="font-arabic inline-block align-baseline text-[1.2em] leading-[1.9] px-0.5"
            >
              {part}
            </span>
          );
        }
        return <React.Fragment key={`${keyPrefix}-lt-${idx}`}>{part}</React.Fragment>;
      })}
    </React.Fragment>
  );
}

function renderLineSegments(line: string, lineIdx: number, isLineArabic: boolean): React.ReactNode {
  const hasMathHint =
    line.includes('$') || line.includes('\\(') || line.includes('\\[');

  if (!hasMathHint) {
    return renderTextWithArabicRuns(line, `l${lineIdx}`, isLineArabic);
  }

  const segments = parseMathSegments(line);
  return segments.map((seg, idx) => {
    if (seg.type === 'text') {
      return renderTextWithArabicRuns(seg.value, `l${lineIdx}-s${idx}`, isLineArabic);
    }

    try {
      const html = katex.renderToString(seg.value, {
        displayMode: seg.type === 'block-math',
        throwOnError: false,
        strict: false,
        trust: false,
      });

      if (seg.type === 'block-math') {
        return (
          <span
            key={`l${lineIdx}-m${idx}`}
            dir="ltr"
            className="block my-2 overflow-x-auto"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      }

      return (
        <span
          key={`l${lineIdx}-m${idx}`}
          dir="ltr"
          className="inline-block align-middle mx-0.5"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    } catch {
      return <span key={`l${lineIdx}-err${idx}`}>{seg.value}</span>;
    }
  });
}

export const MathText: React.FC<MathTextProps> = ({ text, className = '' }) => {
  const safeText = typeof text === 'string' ? text : '';
  const normalized = useMemo(
    () => safeText.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
    [safeText]
  );

  const lines = useMemo(() => normalized.split('\n'), [normalized]);

  // Teks 1 baris tanpa baris baru: tetap bisa dirender inline dengan dukungan Arab & LaTeX
  if (lines.length <= 1) {
    const line = lines[0] ?? '';
    const isAr = isArabicDominantLine(line);
    if (isAr) {
      return (
        <span
          dir="rtl"
          lang="ar"
          className={`block text-right whitespace-pre-wrap break-words ${className}`}
        >
          {renderLineSegments(line, 0, true)}
        </span>
      );
    }
    return (
      <span dir="auto" className={`whitespace-pre-wrap break-words ${className}`}>
        {renderLineSegments(line, 0, false)}
      </span>
    );
  }

  // Multi-baris: setiap tekan Enter (\n) dirender sebagai baris baru terpisah dengan arah RTL/LTR otomatis per baris
  return (
    <span className={`block space-y-1 break-words ${className}`}>
      {lines.map((line, idx) => {
        if (line.trim() === '') {
          return <span key={`br-${idx}`} className="block h-2.5" aria-hidden="true" />;
        }
        const isAr = isArabicDominantLine(line);
        return (
          <span
            key={`ln-${idx}`}
            dir={isAr ? 'rtl' : 'auto'}
            lang={isAr ? 'ar' : undefined}
            className={`block whitespace-pre-wrap ${isAr ? 'text-right' : ''}`}
          >
            {renderLineSegments(line, idx, isAr)}
          </span>
        );
      })}
    </span>
  );
};
