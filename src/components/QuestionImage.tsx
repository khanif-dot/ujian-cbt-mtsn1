import React, { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { normalizeQuestionImageUrl } from '@/src/lib/supabase';

interface QuestionImageProps {
  src?: string | null;
  alt: string;
  className?: string;
  lazy?: boolean;
  compact?: boolean;
}

export const QuestionImage: React.FC<QuestionImageProps> = ({
  src,
  alt,
  className = '',
  lazy = true,
  compact = false,
}) => {
  const normalizedSrc = normalizeQuestionImageUrl(src);
  const [hasError, setHasError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    setHasError(false);
    setRetryCount(0);
  }, [normalizedSrc]);

  if (!normalizedSrc) return null;

  const effectiveSrc =
    retryCount > 0 && /^https?:\/\//i.test(normalizedSrc)
      ? `${normalizedSrc}${normalizedSrc.includes('?') ? '&' : '?'}r=${retryCount}`
      : normalizedSrc;

  if (hasError) {
    return (
      <div
        className={`inline-flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 ${
          compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-2 text-xs'
        }`}
      >
        <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0" />
        <span>Gambar tidak dapat dimuat.</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setHasError(false);
            setRetryCount((c) => c + 1);
          }}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white border border-amber-300 hover:bg-amber-100 text-amber-900 font-semibold cursor-pointer"
        >
          <RefreshCw className="w-3 h-3" />
          <span>Muat Ulang</span>
        </button>
      </div>
    );
  }

  return (
    <img
      src={effectiveSrc}
      alt={alt}
      loading={lazy ? 'lazy' : 'eager'}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setHasError(true)}
      className={className}
    />
  );
};
