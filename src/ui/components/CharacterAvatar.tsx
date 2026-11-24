import { useState } from 'react';
import { getImageUrl, useAssetManifest } from '../assets';

interface CharacterAvatarProps {
  portraitKey: string;
  name: string;
  accentColor?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  ring?: boolean;
}

const SIZE_CLASSES: Record<NonNullable<CharacterAvatarProps['size']>, string> = {
  xs: 'w-7 h-7 text-[10px]',
  sm: 'w-9 h-9 text-xs',
  md: 'w-12 h-12 text-sm',
  lg: 'w-16 h-16 text-base',
  xl: 'w-20 h-20 text-lg',
};

export function CharacterAvatar({
  portraitKey,
  name,
  accentColor = '#38bdf8',
  size = 'md',
  className = '',
  ring = false,
}: CharacterAvatarProps) {
  const { images } = useAssetManifest();
  const [failed, setFailed] = useState(false);

  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  const src = getImageUrl(portraitKey, images);

  return (
    <div
      className={`relative shrink-0 rounded-lg overflow-hidden bg-slate-900 border flex items-center justify-center select-none ${SIZE_CLASSES[size]} ${className}`}
      style={{
        borderColor: ring ? accentColor : 'rgba(148, 163, 184, 0.28)',
        boxShadow: ring ? `0 0 0 2px ${accentColor}33` : undefined,
      }}
    >
      {!failed ? (
        <>
          <img
            src={src}
            alt={name}
            onError={() => setFailed(true)}
            className="w-full h-full object-cover object-top contrast-[1.04] saturate-[0.96]"
            draggable={false}
          />
          <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_16px_rgba(2,6,23,0.55)]" />
        </>
      ) : (
        <div
          className="w-full h-full flex items-center justify-center font-display font-bold tracking-wider text-slate-100"
          style={{
            background: `radial-gradient(circle at 30% 25%, ${accentColor}44, #0b1324 85%)`,
          }}
        >
          {initials}
        </div>
      )}
    </div>
  );
}
